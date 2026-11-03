const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { withErpContext, AuthRequiredError, redactSensitiveText } = require('./shared.js');
const { createStore, ownerOf, canonical, digest, failure, alive } = require('./mcp-job-store.js');
const { adaptResult, consumePages, StreamFailure } = require('./mcp-artifacts.js');

const ACTIVE = new Set(['queued', 'running']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function createJobs({ rootDir, getOperation, waitMs = 750 } = {}) {
  if (typeof getOperation !== 'function') throw new TypeError('getOperation is required');
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 5000) throw new TypeError('waitMs must be between 0 and 5000');
  const store = createStore(rootDir);
  const instance = crypto.randomUUID();
  const local = new Map();
  const admissions = new Set();
  let closed = false;

  function receipt(record, note) {
    const result = {};
    for (const key of ['jobId', 'operation', 'state', 'createdAt', 'updatedAt', 'progress', 'result', 'error']) {
      if (record[key] !== undefined) result[key] = record[key];
    }
    if (ACTIVE.has(record.state)) result.pollAfterMs = 1000;
    if (note) result.error = note;
    return structuredClone(result);
  }

  async function owned(jobId, session) {
    const owner = ownerOf(session);
    const record = await store.read(jobId);
    if (record.owner !== owner) throw failure('NOT_FOUND', 'Job not found.');
    return record;
  }

  function persist(entry) {
    const copy = structuredClone(entry.record);
    const next = entry.writes.catch(() => {}).then(() => store.write(copy));
    entry.writes = next;
    return next;
  }

  async function status(jobId, session) {
    const record = await owned(jobId, session);
    const entry = local.get(jobId);
    if (entry) return receipt(entry.record);
    if (ACTIVE.has(record.state)) {
      if (!alive(record.process?.pid)) {
        record.state = 'interrupted';
        record.updatedAt = new Date().toISOString();
        record.error = { code: 'PROCESS_INTERRUPTED', message: 'The local worker stopped. No automatic retry was made.' };
        await store.write(record);
      } else return receipt(record, { code: 'STATE_UNCERTAIN', message: 'Another local worker owns this job; its last saved state is shown.' });
    }
    return receipt(record);
  }

  async function list(session, { limit = 20 } = {}) {
    session = { ...session };
    const owner = ownerOf(session);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure('INVALID_INPUT', 'limit must be an integer between 1 and 100.');
    let entries;
    try { entries = await fs.readdir(store.jobsDir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return { jobs: [] }; throw error; }
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      try {
        const record = await store.read(entry.name);
        if (record.owner === owner) records.push(record);
      } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId));
    const jobs = [];
    for (const record of records.slice(0, limit)) {
      const { result, ...summary } = await status(record.jobId, session);
      jobs.push({ ...summary, hasResult: Boolean(result), ...(result?.artifact ? { artifact: result.artifact } : {}) });
    }
    return { jobs };
  }

  async function exportLock(entry) {
    const lock = path.join(store.jobsDir, 'exports', entry.record.owner);
    const reaper = `${lock}.reaping`;
    const identity = { pid: process.pid, instance, jobId: entry.record.jobId };
    let uncertain = 0;
    const incomplete = () => failure('EXPORT_LOCK_UNCERTAIN', 'Export coordination is incomplete. No new ERP request was made; inspect the local task history before retrying.');
    function waitForPublication() { if (++uncertain >= 10) throw incomplete(); }
    while (!closed && entry.record.state === 'queued') {
      try { await fs.access(reaper); waitForPublication(); await pause(20); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
        return async () => {
          const current = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
          if (current.instance === instance && current.jobId === identity.jobId) await fs.rm(lock, { recursive: true, force: true });
        };
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      let holder;
      try { holder = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!holder) waitForPublication();
      else {
        if (!Number.isSafeInteger(holder.pid) || holder.pid < 1 || typeof holder.instance !== 'string' || typeof holder.jobId !== 'string') throw incomplete();
        uncertain = 0;
      }
      if (holder && !alive(holder.pid)) {
        try {
          await fs.mkdir(reaper, { mode: 0o700 });
        } catch (error) { if (error.code === 'EEXIST') { await pause(20); continue; } throw error; }
        try {
          const current = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
          if (current.instance === holder.instance && !alive(current.pid)) await fs.rm(lock, { recursive: true, force: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        finally { await fs.rmdir(reaper); }
      }
      await pause(20);
    }
    return null;
  }

  async function run(entry, definition, session) {
    let release;
    const active = () => !closed && ACTIVE.has(entry.record.state);
    try {
      if (definition.effect === 'export') release = await exportLock(entry);
      if (!active()) return;
      entry.record.state = 'running';
      entry.record.updatedAt = new Date().toISOString();
      await persist(entry);
      if (!active()) return;
      const dir = store.jobDir(entry.record.jobId);
      const outputPath = path.join(dir, entry.record.operation === 'sales_volume_export' ? 'export.csv' : 'export.xlsx');
      const result = await withErpContext(session, async () => {
        const value = await definition.invoke(structuredClone(entry.record.params), {
          outputPath,
          onProgress: async progress => {
            if (!active()) throw failure('JOB_INTERRUPTED', 'The local worker stopped.');
            const saved = {};
            for (const key of ['taskId', 'stage', 'status', 'phase', 'boxes']) {
              if (typeof progress?.[key] === 'string') saved[key] = progress[key].slice(0, 200);
              else if (typeof progress?.[key] === 'number' && Number.isFinite(progress[key])) saved[key] = progress[key];
            }
            if (entry.record.operation === 'packing_detail_export' && typeof progress?.taskId === 'string' && progress.taskId) entry.record.checkpoint = { taskId: progress.taskId };
            entry.record.progress = saved;
            entry.record.updatedAt = new Date().toISOString();
            await persist(entry);
            if (!active()) throw failure('JOB_INTERRUPTED', 'The local worker stopped.');
          },
        });
        if (!active()) return;
        if (value && typeof value[Symbol.asyncIterator] === 'function') return consumePages(value, { dir, active });
        return adaptResult(value, { dir, outputPath });
      });
      if (!active()) return;
      entry.record.state = 'succeeded';
      entry.record.result = result;
      entry.record.updatedAt = new Date().toISOString();
      await persist(entry);
    } catch (error) {
      if (!active()) return;
      entry.record.state = 'failed';
      entry.record.updatedAt = new Date().toISOString();
      const cause = error instanceof StreamFailure ? error.cause : error;
      entry.record.error = cause instanceof AuthRequiredError || cause?.code === 'LOGIN_REQUIRED'
        ? { code: 'LOGIN_REQUIRED', message: 'The ERP session needs browser login.' }
        : { code: 'EXECUTION_FAILED', message: redactSensitiveText(cause?.message || 'ERP execution failed.', [session.token, session.username]).slice(0, 1200) };
      if (error instanceof StreamFailure) entry.record.result = error.partialResult;
      await persist(entry);
    } finally {
      if (release) await release();
    }
  }

  async function admit(operation, params, session, { requestId } = {}) {
    if (closed) throw failure('JOBS_CLOSED', 'The local worker is closed.');
    session = { ...session };
    const owner = ownerOf(session);
    const definition = getOperation(operation);
    if (!definition) throw failure('UNKNOWN_OPERATION', 'Unknown ERP operation.');
    const parsed = definition.schema.parse(params);
    if (definition.effect === 'export' && requestId === undefined) throw failure('REQUEST_ID_REQUIRED', 'Exports require a stable requestId.');
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200)) throw failure('INVALID_INPUT', 'requestId must be a nonempty string of at most 200 characters.');
    await store.init();
    if (closed) throw failure('JOBS_CLOSED', 'The local worker is closed.');
    const fingerprint = digest(canonical({ operation, params: parsed }));
    let claim;
    if (requestId !== undefined) {
      claim = path.join(store.jobsDir, 'requests', digest(canonical([owner, requestId])));
      try { await fs.mkdir(claim, { mode: 0o700 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let saved;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          try { saved = JSON.parse(await fs.readFile(path.join(claim, 'claim.json'), 'utf8')); break; }
          catch (readError) { if (readError.code !== 'ENOENT') throw failure('REQUEST_UNCERTAIN', 'The saved request admission is uncertain; it will not be replayed.'); await pause(10); }
        }
        if (!saved) throw failure('REQUEST_UNCERTAIN', 'The saved request admission is uncertain; it will not be replayed.');
        if (saved.fingerprint !== fingerprint) throw failure('REQUEST_CONFLICT', 'requestId was already used for a different call.');
        return status(saved.jobId, session);
      }
    }
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const record = { jobId, operation, state: 'queued', createdAt: now, updatedAt: now, owner, params: parsed, fingerprint, process: { pid: process.pid, instance } };
    if (operation === 'packing_detail_export' && parsed.taskId) record.checkpoint = { taskId: parsed.taskId };
    const entry = { record, writes: Promise.resolve() };
    await fs.mkdir(store.jobDir(jobId), { mode: 0o700 });
    await persist(entry);
    if (claim) {
      const temporary = path.join(claim, `${crypto.randomUUID()}.tmp`);
      await fs.writeFile(temporary, JSON.stringify({ jobId, fingerprint }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, path.join(claim, 'claim.json'));
    }
    local.set(jobId, entry);
    if (closed) {
      record.state = 'interrupted';
      record.error = { code: 'PROCESS_INTERRUPTED', message: 'The local worker stopped. No automatic retry was made.' };
      await persist(entry);
    } else {
      entry.done = run(entry, definition, { ...session }).catch(() => {});
      if (waitMs) {
        let timer;
        await Promise.race([entry.done, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
        clearTimeout(timer);
      }
    }
    return receipt(record);
  }

  function start(...args) {
    const pending = admit(...args);
    admissions.add(pending);
    pending.finally(() => admissions.delete(pending)).catch(() => {});
    return pending;
  }

  async function resume(jobId, session, { requestId } = {}) {
    session = { ...session };
    const record = await owned(jobId, session);
    if (ACTIVE.has(record.state) && alive(record.process?.pid)) throw failure('RESUME_UNSUPPORTED', 'This job may still be running.');
    if (record.operation !== 'packing_detail_export' || !record.checkpoint?.taskId) throw failure('RESUME_UNSUPPORTED', 'Only packing jobs with a saved task ID support explicit resume.');
    if (!requestId) throw failure('REQUEST_ID_REQUIRED', 'Resume requires a stable requestId.');
    return start(record.operation, { ...record.params, taskId: record.checkpoint.taskId }, session, { requestId });
  }

  async function cancel(jobId, session) {
    const record = await owned(jobId, session);
    const entry = local.get(jobId);
    if (record.state === 'queued' && entry?.record.state === 'queued') {
      entry.record.state = 'cancelled';
      entry.record.updatedAt = new Date().toISOString();
      await persist(entry);
      return receipt(entry.record);
    }
    if (ACTIVE.has(record.state)) return receipt(entry?.record || record, { code: 'CANCELLATION_UNSUPPORTED', message: 'Running ERP work cannot be cancelled end to end.' });
    return receipt(entry?.record || record);
  }

  async function close() {
    closed = true;
    await Promise.allSettled([...admissions]);
    for (const entry of local.values()) {
      if (!ACTIVE.has(entry.record.state)) continue;
      entry.record.state = 'interrupted';
      entry.record.updatedAt = new Date().toISOString();
      entry.record.error = { code: 'PROCESS_INTERRUPTED', message: 'The local worker stopped. ERP work was not cancelled.' };
      await persist(entry);
    }
  }

  return { start, status, list, resume, cancel, close };
}

module.exports = { createJobs };
