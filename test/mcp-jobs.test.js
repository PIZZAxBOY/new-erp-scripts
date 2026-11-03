const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { z } = require('zod');
const { createJobs } = require('../scripts/mcp-jobs.js');
const { ownerOf, canonical, digest } = require('../scripts/mcp-job-store.js');
const { getBaseUrl, getTokenFromArgs, AuthRequiredError } = require('../scripts/shared.js');

const session = { baseUrl: 'https://fake.invalid', userId: 7, username: 'fixture-user', token: 'fixture-private-token' };
const other = { ...session, userId: 8, username: 'another-fixture', token: 'another-private-token' };
const empty = z.object({}).strict();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, operations, options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-jobs-test-'));
  const instances = [];
  function instance(overrides = {}) {
    const jobs = createJobs({ rootDir, getOperation: name => operations[name], ...options, ...overrides });
    instances.push(jobs);
    return jobs;
  }
  t.after(async () => {
    for (const jobs of instances) await jobs.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  return { rootDir, instance, jobs: instance() };
}

async function finished(jobs, id, owner = session) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await jobs.status(id, owner);
    if (!['queued', 'running'].includes(result.state)) return result;
    await delay(10);
  }
  assert.fail('Fake job failed to finish');
}

test('initialization is lazy; fast reads finish and slow reads return bounded receipts', async t => {
  const gate = deferred();
  const { rootDir, jobs } = await setup(t, {
    fast: { effect: 'read', schema: empty, invoke: () => [{ sku: 'A' }] },
    slow: { effect: 'read', schema: empty, invoke: () => gate.promise },
  }, { waitMs: 25 });
  assert.deepEqual(await fs.readdir(rootDir), []);
  const fast = await jobs.start('fast', {}, session);
  assert.equal(fast.state, 'succeeded');
  assert.deepEqual(fast.result.data, { list: [{ sku: 'A' }] });
  const slow = await jobs.start('slow', {}, session);
  assert.equal(slow.state, 'running');
  assert.equal(slow.pollAfterMs, 1000);
  assert.equal('owner' in slow, false);
  gate.resolve({ value: 2 });
  assert.equal((await finished(jobs, slow.jobId)).result.data.value, 2);
});

test('a configured existing export root keeps its permissions while owned task directories stay private', async t => {
  if (process.platform === 'win32') return;
  const { jobs, rootDir } = await setup(t, { read: { effect: 'read', schema: empty, invoke: () => ({ ok: true }) } });
  await fs.chmod(rootDir, 0o755);
  const result = await jobs.start('read', {}, session);
  assert.equal((await fs.stat(rootDir)).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(rootDir, '.mcp-jobs', result.jobId))).mode & 0o777, 0o700);
});

test('job errors retain useful validation reasons while masking captured credentials', async t => {
  const { jobs } = await setup(t, { read: { effect: 'read', schema: empty,
    invoke: () => { throw new Error(`startDate is required; ${session.token} ${session.username}`); } } });
  const result = await jobs.start('read', {}, session);
  assert.equal(result.state, 'failed');
  assert.match(result.error.message, /startDate is required/);
  for (const secret of [session.token, session.username]) assert.ok(!JSON.stringify(result).includes(secret));
});

test('job history stays compact while individual status preserves the complete result', async t => {
  const value = { detail: 'x'.repeat(8000) };
  const { jobs } = await setup(t, { read: { effect: 'read', schema: empty, invoke: () => value } });
  const first = await jobs.start('read', {}, session);
  await jobs.start('read', {}, session);
  const history = await jobs.list(session, { limit: 2 });
  assert.equal(history.jobs.length, 2);
  const bytes = Buffer.byteLength(JSON.stringify(history));
  assert.ok(bytes < 4000, `History contains ${bytes} bytes; expected fewer than 4000`);
  assert.deepEqual((await jobs.status(first.jobId, session)).result.data, value);
});

test('stable requests deduplicate normalized defaults, conflict on changes, and bind owner independently of token', async t => {
  let calls = 0;
  const operation = { effect: 'export', schema: z.object({ n: z.number().int().default(1) }).strict(), invoke: () => { calls += 1; return { ok: true }; } };
  const { jobs, rootDir } = await setup(t, { export: operation });
  await assert.rejects(jobs.start('export', {}, session), { code: 'REQUEST_ID_REQUIRED' });
  const first = await jobs.start('export', {}, session, { requestId: 'stable' });
  const second = await jobs.start('export', { n: 1 }, { ...session, token: 'renewed' }, { requestId: 'stable' });
  assert.equal(first.jobId, second.jobId);
  assert.equal(calls, 1);
  await assert.rejects(jobs.start('export', { n: 2 }, session, { requestId: 'stable' }), { code: 'REQUEST_CONFLICT' });
  const journal = await fs.readFile(path.join(rootDir, '.mcp-jobs', first.jobId, 'job.json'), 'utf8');
  for (const secret of [session.token, session.username, 'renewed']) assert.equal(journal.includes(secret), false);
  assert.equal(JSON.parse(journal).params.n, 1);
  assert.notEqual((await jobs.start('export', {}, other, { requestId: 'stable' })).jobId, first.jobId);
});

test('incomplete export coordination fails without starting ERP work or waiting indefinitely', async t => {
  for (const suffix of ['', '.reaping']) {
    let calls = 0;
    const operation = { effect: 'export', schema: empty, invoke: () => { calls++; return {}; } };
    const { jobs, rootDir } = await setup(t, { export: operation }, { waitMs: 500 });
    await fs.mkdir(path.join(rootDir, '.mcp-jobs', 'exports', ownerOf(session) + suffix), { recursive: true, mode: 0o700 });
    const result = await jobs.start('export', {}, session, { requestId: 'incomplete-lock' });
    assert.equal(result.state, 'failed');
    assert.equal(calls, 0);
  }
});

test('atomic admission coexists across instances, does not interrupt live owners, and never replays incomplete claims', async t => {
  const gate = deferred(); let calls = 0;
  const operation = { effect: 'export', schema: empty, invoke: () => { calls += 1; return gate.promise; } };
  const { jobs, instance, rootDir } = await setup(t, { export: operation }, { waitMs: 0 });
  const peer = instance();
  const [a, b] = await Promise.all([jobs.start('export', {}, session, { requestId: 'one' }), peer.start('export', {}, session, { requestId: 'one' })]);
  assert.equal(a.jobId, b.jobId);
  await delay(30);
  assert.equal(calls, 1);
  const observer = instance();
  const observed = await observer.status(a.jobId, session);
  assert.equal(observed.state, 'running');
  assert.equal(observed.error.code, 'STATE_UNCERTAIN');
  const claim = path.join(rootDir, '.mcp-jobs', 'requests', digest(canonical([ownerOf(session), 'incomplete'])));
  await fs.mkdir(claim, { mode: 0o700 });
  await assert.rejects(peer.start('export', {}, session, { requestId: 'incomplete' }), { code: 'REQUEST_UNCERTAIN' });
  assert.equal(calls, 1);
  gate.resolve({ done: true });
  await finished(jobs, a.jobId);
});

test('status/list/resume/cancel enforce owner without leaking foreign existence', async t => {
  const { jobs } = await setup(t, { read: { effect: 'read', schema: empty, invoke: () => ({ ok: true }) } });
  const receipt = await jobs.start('read', {}, session);
  for (const id of [receipt.jobId, crypto.randomUUID()]) {
    await assert.rejects(jobs.status(id, other), { code: 'NOT_FOUND', message: 'Job not found.' });
    await assert.rejects(jobs.resume(id, other, { requestId: 'resume' }), { code: 'NOT_FOUND', message: 'Job not found.' });
    await assert.rejects(jobs.cancel(id, other), { code: 'NOT_FOUND', message: 'Job not found.' });
  }
  assert.deepEqual(await jobs.list(other), { jobs: [] });
  assert.equal((await jobs.list(session)).jobs.length, 1);
});

test('dead process records become interrupted without replay; close blocks admission and late publication', async t => {
  const gate = deferred(); let calls = 0;
  const operation = { effect: 'read', schema: empty, invoke: () => { calls += 1; return gate.promise; } };
  const { rootDir, jobs, instance } = await setup(t, { read: operation }, { waitMs: 0 });
  const first = await jobs.start('read', {}, session, { requestId: 'read-once' });
  await delay(20);
  await jobs.close();
  gate.resolve({ late: true });
  await delay(20);
  assert.equal((await jobs.status(first.jobId, session)).state, 'interrupted');
  assert.equal((await jobs.status(first.jobId, session)).result, undefined);
  await assert.rejects(jobs.start('read', {}, session), { code: 'JOBS_CLOSED' });
  const journalFile = path.join(rootDir, '.mcp-jobs', first.jobId, 'job.json');
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  journal.state = 'running'; journal.process.pid = 2147483647;
  await fs.writeFile(journalFile, JSON.stringify(journal));
  const restarted = instance();
  assert.equal((await restarted.status(first.jobId, session)).state, 'interrupted');
  assert.equal((await restarted.start('read', {}, session, { requestId: 'read-once' })).jobId, first.jobId);
  assert.equal(calls, 1);
});

test('same-owner exports serialize across instances; queued cancellation skips invocation and running cancellation is unsupported', async t => {
  const gate = deferred(); const began = deferred(); let calls = 0;
  const operation = { effect: 'export', schema: empty, invoke: () => { calls += 1; began.resolve(); return gate.promise; } };
  const { jobs, instance } = await setup(t, {
    export: operation,
    read: { effect: 'read', schema: empty, invoke: () => ({ independent: true }) },
  }, { waitMs: 15 });
  const peer = instance();
  const first = await jobs.start('export', {}, session, { requestId: 'first' });
  await began.promise;
  const queued = await peer.start('export', {}, session, { requestId: 'second' });
  assert.equal(queued.state, 'queued');
  assert.equal((await jobs.cancel(first.jobId, session)).error.code, 'CANCELLATION_UNSUPPORTED');
  assert.equal((await peer.cancel(queued.jobId, session)).state, 'cancelled');
  assert.equal((await peer.start('read', {}, session)).state, 'succeeded');
  gate.resolve({ done: true });
  await finished(jobs, first.jobId);
  assert.equal(calls, 1);
});

test('Buffer and server-owned CSV outputs preserve bytes and private file permissions; zero boxes create no artifact', async t => {
  const bytes = Buffer.from([0x50, 0x4b, 0, 255, 12]);
  const { jobs, rootDir } = await setup(t, {
    buffer: { effect: 'export', schema: empty, invoke: () => ({ taskId: 'buffer-id', file: bytes }) },
    sales_volume_export: { effect: 'export', schema: empty, invoke: async (_, { outputPath }) => {
      await assert.rejects(fs.stat(outputPath), { code: 'ENOENT' });
      await fs.writeFile(outputPath, Buffer.from([0xff, 0xfe, 0, 10]), { flag: 'wx', mode: 0o600 });
      return [{ taskId: 'csv-id', output: outputPath, bytes: 4, encoding: 'GBK' }];
    } },
    packing_detail_export: { effect: 'export', schema: empty, invoke: () => ({ taskId: '', boxes: 0, output: null, bytes: 0 }) },
  });
  const workbook = await jobs.start('buffer', {}, session, { requestId: 'buffer' });
  assert.deepEqual(await fs.readFile(workbook.result.artifact.path), bytes);
  assert.equal(workbook.result.artifact.bytes, bytes.length);
  assert.equal(workbook.result.data, undefined);
  const csv = await jobs.start('sales_volume_export', {}, session, { requestId: 'csv' });
  assert.deepEqual(await fs.readFile(csv.result.artifact.path), Buffer.from([0xff, 0xfe, 0, 10]));
  assert.equal(csv.result.artifact.mediaType, 'text/csv');
  const zero = await jobs.start('packing_detail_export', {}, session, { requestId: 'zero' });
  assert.equal(zero.result.artifact, undefined);
  assert.equal(zero.result.data.boxes, 0);
  for (const artifact of [workbook.result.artifact, csv.result.artifact]) {
    assert.equal((await fs.stat(artifact.path)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(artifact.path))).mode & 0o777, 0o700);
  }
  assert.equal((await fs.stat(rootDir)).mode & 0o777, 0o700);
});

test('large JSON is lossless on disk with a bounded primitive preview retaining SKU/ASIN/imageUrl and no invented completeness', async t => {
  const value = Array.from({ length: 100 }, (_, i) => ({ sku: `sku-${i}`, ASIN: `asin-${i}`, imageUrl: `https://images.invalid/${i}.png`, nested: { detail: 'x'.repeat(500) }, totalCount: 1000 }));
  value[0].imageUrl = `https://images.invalid/asset?signature=${'a'.repeat(800)}`;
  const { jobs } = await setup(t, { evidence: { effect: 'read', schema: empty, invoke: () => value } });
  const receipt = await jobs.start('evidence', {}, session);
  assert.equal(receipt.state, 'succeeded');
  assert.deepEqual(JSON.parse(await fs.readFile(receipt.result.artifact.path, 'utf8')), { list: value });
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 4000);
  assert.equal(receipt.result.preview[0].sku, 'sku-0');
  assert.equal(receipt.result.preview[0].ASIN, 'asin-0');
  assert.equal(receipt.result.preview[0].imageUrl, value[0].imageUrl);
  assert.equal(receipt.result.rowCount, 100);
  assert.equal(receipt.result.complete, undefined);
  assert.equal(receipt.result.totalCount, undefined);
  assert.equal(Object.values(receipt.result.preview[0]).every(v => v === null || typeof v !== 'object'), true);
});

test('generator invocation and consumption both run inside the captured private ERP context; NDJSON preserves each page', async t => {
  const seen = [];
  const pages = [{ list: [{ sku: 'one' }], complete: false, fetchedCount: 1 }, { list: [{ sku: 'two' }], complete: true, fetchedCount: 2 }];
  const operation = { effect: 'stream', schema: empty, invoke: () => {
    seen.push([getBaseUrl(), getTokenFromArgs({})]);
    return (async function* () { for (const page of pages) { await delay(1); seen.push([getBaseUrl(), getTokenFromArgs({})]); yield page; } })();
  } };
  const { jobs } = await setup(t, { pages: operation });
  const receipt = await jobs.start('pages', {}, session);
  assert.equal(receipt.state, 'succeeded');
  assert.equal(receipt.result.pageCount, 2);
  assert.equal(receipt.result.rowCount, 2);
  assert.equal(receipt.result.complete, true);
  assert.deepEqual((await fs.readFile(receipt.result.artifact.path, 'utf8')).trim().split('\n').map(JSON.parse), pages);
  assert.deepEqual(seen, Array(3).fill([session.baseUrl, session.token]));
});

test('iterator failure fails the job and marks the full written partial stream incomplete without leaking errors', async t => {
  const { jobs } = await setup(t, { pages: { effect: 'stream', schema: empty, invoke: async function* () {
    yield { list: [{ sku: 'first' }], complete: false };
    throw new Error(`private ${session.token}`);
  } } });
  const receipt = await jobs.start('pages', {}, session);
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.result.artifact.complete, false);
  assert.equal(receipt.result.artifact.rowCount, 1);
  assert.equal(receipt.result.complete, undefined);
  assert.equal(JSON.stringify(receipt).includes(session.token), false);
  assert.equal((await fs.readFile(receipt.result.artifact.path, 'utf8')).split('\n').filter(Boolean).length, 1);
});

test('packing checkpoints are durable before polling continues and explicit resume uses saved scope and strict revalidation', async t => {
  let rootDir; const calls = [];
  const schema = z.object({ project: z.string(), warehouses: z.string(), startDate: z.string(), endDate: z.string(), taskId: z.string().optional() }).strict();
  const operation = { effect: 'export', schema, invoke: async (params, hooks) => {
    calls.push(params);
    if (params.taskId) return { taskId: params.taskId, boxes: 0, output: null };
    await hooks.onProgress({ stage: 'waiting', boxes: 4, taskId: 'saved-task' });
    const entries = (await fs.readdir(path.join(rootDir, '.mcp-jobs'))).filter(name => /^[0-9a-f-]{36}$/.test(name));
    const journal = JSON.parse(await fs.readFile(path.join(rootDir, '.mcp-jobs', entries[0], 'job.json'), 'utf8'));
    assert.equal(journal.checkpoint.taskId, 'saved-task');
    throw new Error('polling failed');
  } };
  const fixture = await setup(t, { packing_detail_export: operation }); rootDir = fixture.rootDir;
  const scope = { project: 'p', warehouses: 'W', startDate: '2026-01-01', endDate: '2026-01-02' };
  const failed = await fixture.jobs.start('packing_detail_export', scope, session, { requestId: 'packing' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.progress.taskId, 'saved-task');
  assert.equal(failed.progress.boxes, 4);
  const resumed = await fixture.jobs.resume(failed.jobId, session, { requestId: 'resume' });
  assert.equal(resumed.state, 'succeeded');
  assert.deepEqual(calls[1], { ...scope, taskId: 'saved-task' });
  const journalPath = path.join(rootDir, '.mcp-jobs', failed.jobId, 'job.json');
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8')); journal.params.unknown = true;
  await fs.writeFile(journalPath, JSON.stringify(journal));
  await assert.rejects(fixture.jobs.resume(failed.jobId, session, { requestId: 'strict' }));
  assert.equal(calls.length, 2);
});

test('upstream authentication failures produce short login-required receipts', async t => {
  const { jobs } = await setup(t, {
    read: { effect: 'read', schema: empty, invoke: () => { throw new AuthRequiredError('fake.invalid', 'private token'); } },
    pages: { effect: 'stream', schema: empty, invoke: async function* () {
      yield { list: [{ sku: 'before-login-expired' }] };
      throw new AuthRequiredError('fake.invalid', 'private token');
    } },
  });
  const receipt = await jobs.start('read', {}, session);
  assert.equal(receipt.state, 'failed');
  assert.equal(receipt.error.code, 'LOGIN_REQUIRED');
  assert.equal(JSON.stringify(receipt).includes('private token'), false);
  const stream = await jobs.start('pages', {}, session);
  assert.equal(stream.error.code, 'LOGIN_REQUIRED');
  assert.equal(stream.result.artifact.complete, false);
  assert.equal(JSON.stringify(stream).includes('private token'), false);
});

test('session identity and token are captured before asynchronous admission, including generator consumption', async t => {
  const seen = [];
  const { jobs } = await setup(t, { stream: { effect: 'stream', schema: empty, invoke: async function* () {
    seen.push(getTokenFromArgs({}));
    await delay(5);
    seen.push(getTokenFromArgs({}));
    yield { list: [] };
  } } });
  const mutable = { ...session };
  const pending = jobs.start('stream', {}, mutable);
  Object.assign(mutable, other);
  const result = await pending;
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(seen, [session.token, session.token]);
  assert.equal((await jobs.status(result.jobId, session)).state, 'succeeded');
  await assert.rejects(jobs.status(result.jobId, other), { code: 'NOT_FOUND' });
});

test('independent OS processes atomically admit one stable export request', async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-job-process-test-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const modulePath = require.resolve('../scripts/mcp-jobs.js');
  const script = `
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const { z } = require('zod');
    const { createJobs } = require(${JSON.stringify(modulePath)});
    const rootDir = process.argv[1];
    const jobs = createJobs({ rootDir, getOperation: () => ({ effect:'export', schema:z.object({}).strict(), invoke:async () => {
      await fs.appendFile(path.join(rootDir,'invocations'), 'one\\n');
      await new Promise(resolve => setTimeout(resolve, 50)); return {ok:true};
    } }) });
    jobs.start('export',{},${JSON.stringify(session)},{requestId:'shared'}).then(async result => {
      process.stdout.write(JSON.stringify(result)); await jobs.close();
    }).catch(error => { process.stderr.write(error.stack); process.exitCode=1; });`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, rootDir], { cwd: path.resolve(__dirname, '..') });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => { if (code) reject(new Error(stderr)); else resolve(JSON.parse(stdout)); });
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.jobId, b.jobId);
  assert.equal(await fs.readFile(path.join(rootDir, 'invocations'), 'utf8'), 'one\n');
});
