const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readSession } = require('../scripts/local-session.js');
const { acquireProcessLock, createHttpHandler, loadConfig, readToken, startHttpServer, validateConfig } = require('../scripts/mcp-http.js');

const TOKEN = 'test-token-for-in-process-http-mcp-only-0001';
const PUBLIC_URL = 'https://mcp.example.invalid/mcp';
const PUBLIC_ORIGIN = 'https://mcp.example.invalid';
const PUBLIC_HOST = 'mcp.example.invalid';
const FIRST_JOB = '00000000-0000-4000-8000-000000000001';
const SECOND_JOB = '00000000-0000-4000-8000-000000000002';
const UNKNOWN_JOB = '00000000-0000-4000-8000-000000000099';
const session = {
  baseUrl: 'https://erp.example.invalid',
  username: 'test-owner',
  token: 'synthetic-session-token',
  userId: 12,
};

function configFor(dataDir, rootDir = dataDir) {
  return {
    publicUrl: PUBLIC_URL,
    port: 8443,
    tokenFile: path.join(rootDir, 'token'),
    dataDir,
    sessionFiles: [path.join(rootDir, 'session.json')],
  };
}

function toolPayload(result) {
  const text = result.content?.find(item => item.type === 'text')?.text;
  assert.equal(typeof text, 'string');
  return JSON.parse(text);
}

function makeRequest(pathname, { method = 'GET', token = TOKEN, origin = PUBLIC_ORIGIN,
  host = PUBLIC_HOST, headers = {}, body, duplex } = {}) {
  const requestHeaders = new Headers({ host, ...headers });
  if (token !== null) requestHeaders.set('authorization', `Bearer ${token}`);
  if (origin !== null) requestHeaders.set('origin', origin);
  if (body !== undefined && method === 'POST' && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json');
  }
  return new Request(`${PUBLIC_ORIGIN}${pathname}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body }),
    ...(duplex ? { duplex } : {}),
  });
}

async function createHarness(t, options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-mcp-http-'));
  const dataDir = path.join(rootDir, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  const config = configFor(dataDir, rootDir);
  const records = new Map();
  const calls = { starts: 0, statuses: [], lists: 0, authClose: 0, jobsClose: 0, login: 0, logout: 0 };
  let nextJob = 0;
  const auth = {
    requireSession() { return session; },
    status() { return { state: 'authenticated', loggedIn: true, accounts: 1 }; },
    get login() { calls.login += 1; return async () => ({ ok: true }); },
    get logout() { calls.logout += 1; return async () => ({ ok: true }); },
    async close() { calls.authClose += 1; },
  };
  const jobs = {
    async start(operation, params, owner, options = {}) {
      calls.starts += 1;
      assert.equal(owner, session);
      const jobId = `00000000-0000-4000-8000-${String(++nextJob).padStart(12, '0')}`;
      const record = { jobId, operation, requestId: options.requestId, params, state: 'running' };
      records.set(jobId, record);
      return structuredClone(record);
    },
    async status(jobId, owner) {
      calls.statuses.push({ jobId, owner });
      const record = records.get(jobId);
      if (!record) throw Object.assign(new Error('Job not found'), { code: 'NOT_FOUND' });
      if (record.state === 'running') {
        record.state = 'succeeded';
        record.result = { data: { complete: true } };
      }
      return structuredClone(record);
    },
    async list(owner) {
      calls.lists += 1;
      assert.equal(owner, session);
      return { jobs: [...records.values()].map(({ result, ...summary }) => ({
        ...summary,
        ...(result?.artifact ? { artifact: result.artifact } : {}),
      })) };
    },
    async resume(jobId) { return { jobId, state: 'running' }; },
    async cancel(jobId) { return { jobId, state: 'cancelled' }; },
    async close() { calls.jobsClose += 1; },
  };
  const runtime = { auth, jobs, async close() { await auth.close(); await jobs.close(); } };
  const handler = await createHttpHandler({
    config,
    token: TOKEN,
    runtime,
    ...options,
  });
  t.after(async () => {
    await handler.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  return { config, rootDir, dataDir, records, calls, runtime, handler };
}

async function connectClient(t, harness) {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  let requestCount = 0;
  const transport = new StreamableHTTPClientTransport(new URL(PUBLIC_URL), {
    authProvider: { token: async () => TOKEN },
    requestInit: { headers: { Origin: PUBLIC_ORIGIN } },
    fetch: async (input, init) => {
      requestCount += 1;
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set('host', PUBLIC_HOST);
      return harness.handler(new Request(request, { headers }));
    },
  });
  const client = new Client({ name: 'remote-mcp-http-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  return { client, get requestCount() { return requestCount; } };
}

test('HTTP MCP handshake, discovery, remote auth restrictions, and jobs share runtime across requests', async (t) => {
  const harness = await createHarness(t);
  const connection = await connectClient(t, harness);
  const { client } = connection;
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['erp_discover', 'erp_execute']);
  assert.match(client.getInstructions(), /服务管理员/);

  const discovered = toolPayload(await client.callTool({ name: 'erp_discover', arguments: { query: 'auth' } }));
  const names = discovered.operations.map(operation => operation.name);
  assert.ok(names.includes('auth.status'));
  assert.equal(names.includes('auth.login'), false);
  assert.equal(names.includes('auth.logout'), false);
  const business = toolPayload(await client.callTool({
    name: 'erp_discover',
    arguments: { operation: 'product_detail' },
  }));
  const requirements = business.requirements.join(' ');
  assert.match(requirements, /service administrator/);
  assert.doesNotMatch(requirements, /saved personal ERP login/);
  assert.equal(harness.calls.login, 0);
  assert.equal(harness.calls.logout, 0);

  for (const operation of ['auth.login', 'auth.logout']) {
    const denied = await client.callTool({
      name: 'erp_execute',
      arguments: { operation, params: {} },
    });
    assert.equal(denied.isError, true);
    assert.equal(toolPayload(denied).error.code, 'REMOTE_AUTH_MANAGEMENT_DISABLED');
    assert.doesNotMatch(denied.content[0].text, /password|auth\.login|auth\.logout/);
  }

  const start = await client.callTool({
    name: 'erp_execute',
    arguments: { operation: 'product_detail', params: { asin: 'B012345678' }, requestId: 'http-job-1' },
  });
  const started = toolPayload(start);
  assert.equal(started.state, 'running');
  assert.equal(harness.calls.starts, 1);
  const afterStart = connection.requestCount;
  const polled = await client.callTool({
    name: 'erp_execute',
    arguments: { operation: 'jobs.status', params: { jobId: started.jobId } },
  });
  assert.equal(toolPayload(polled).state, 'succeeded');
  assert.ok(connection.requestCount > afterStart, 'job polling uses a separate HTTP request');
  assert.equal(harness.calls.statuses.at(-1).owner, session);
  assert.equal(harness.calls.authClose, 0);
  assert.equal(harness.calls.jobsClose, 0);

  await client.close();
  await harness.handler.close();
  assert.equal(harness.calls.authClose, 0);
  assert.equal(harness.calls.jobsClose, 0);
  await harness.runtime.close();
  assert.equal(harness.calls.authClose, 1);
  assert.equal(harness.calls.jobsClose, 1);
});

test('HTTP perimeter enforces Host, Origin, Bearer, query, body, rate and minimal health access', async (t) => {
  const harness = await createHarness(t, { maxRequestBytes: 64 });
  const health = await harness.handler(makeRequest('/healthz', { method: 'GET', token: null }));
  assert.deepEqual(await health.json(), { ok: true });
  assert.match(health.headers.get('cache-control'), /no-store/);
  assert.equal(health.headers.get('access-control-allow-origin'), null);

  assert.equal((await harness.handler(makeRequest('/mcp', { method: 'POST', token: null, body: '{}' }))).status, 401);
  assert.equal((await harness.handler(makeRequest('/mcp', { method: 'POST', token: 'incorrect-token-for-this-test', body: '{}' }))).status, 401);
  assert.equal((await harness.handler(makeRequest('/mcp', { method: 'POST', host: 'attacker.example.invalid',
    headers: { 'x-forwarded-host': PUBLIC_HOST }, body: '{}' }))).status, 421);
  assert.equal((await harness.handler(makeRequest('/mcp', { method: 'POST', origin: 'https://other.example.invalid', body: '{}' }))).status, 403);
  assert.equal((await harness.handler(makeRequest('/mcp?token=leaked', { method: 'POST', body: '{}' }))).status, 400);

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const oversized = makeRequest('/mcp', { method: 'POST', body, duplex: 'half' });
  assert.equal((await harness.handler(oversized)).status, 413);
  assert.equal(harness.calls.starts, 0);
  assert.equal(harness.calls.statuses.length, 0);
});

test('HTTP request concurrency and coarse rate limits are bounded', async (t) => {
  const inflight = await createHarness(t, { maxInflight: 1, rateCapacity: 10, ratePerSecond: 0 });
  const first = await inflight.handler(makeRequest('/healthz', { token: null }));
  assert.equal(first.status, 200);
  assert.equal((await inflight.handler(makeRequest('/healthz', { token: null }))).status, 503);
  await first.text();
  assert.equal((await inflight.handler(makeRequest('/healthz', { token: null }))).status, 200);

  const rate = await createHarness(t, { rateCapacity: 1, ratePerSecond: 0 });
  assert.equal((await rate.handler(makeRequest('/healthz', { token: null }))).status, 200);
  assert.equal((await rate.handler(makeRequest('/healthz', { token: null }))).status, 429);
});

test('artifact paths are removed from MCP results and owned complete files download safely', async (t) => {
  const harness = await createHarness(t);
  const artifactFile = path.join(harness.dataDir, '.mcp-jobs', FIRST_JOB, 'result.json');
  await fs.mkdir(path.dirname(artifactFile), { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(harness.dataDir, '.mcp-jobs'), 0o700);
  await fs.chmod(path.dirname(artifactFile), 0o700);
  await fs.writeFile(artifactFile, '{"fixture":true}', { mode: 0o600 });
  const artifact = { path: artifactFile, mediaType: 'application/json', bytes: 16, complete: true };
  harness.records.set(FIRST_JOB, {
    jobId: FIRST_JOB,
    operation: 'product_detail',
    state: 'succeeded',
    result: { artifact },
  });
  harness.records.set(SECOND_JOB, {
    jobId: SECOND_JOB,
    operation: 'product_detail',
    state: 'succeeded',
    result: { artifact: { ...artifact, path: path.join(harness.dataDir, '.mcp-jobs', SECOND_JOB, '..', '..', 'escape', 'result.json') } },
  });
  const incompleteId = '00000000-0000-4000-8000-000000000003';
  harness.records.set(incompleteId, {
    jobId: incompleteId,
    operation: 'product_detail',
    state: 'succeeded',
    result: { artifact: { ...artifact, complete: false } },
  });
  const failedId = '00000000-0000-4000-8000-000000000004';
  harness.records.set(failedId, {
    jobId: failedId,
    operation: 'product_detail',
    state: 'failed',
    error: { code: 'REMOTE_FAILURE', message: 'https://erp.example.invalid/private/path' },
  });

  const { client } = await connectClient(t, harness);
  const status = toolPayload(await client.callTool({
    name: 'erp_execute',
    arguments: { operation: 'jobs.status', params: { jobId: FIRST_JOB } },
  }));
  assert.equal(status.result.artifact.path, undefined);
  assert.equal(status.result.artifact.downloadUrl, `${PUBLIC_ORIGIN}/artifacts/${FIRST_JOB}`);
  const list = toolPayload(await client.callTool({
    name: 'erp_execute',
    arguments: { operation: 'jobs.list', params: { limit: 10 } },
  }));
  const listed = list.jobs.find(job => job.jobId === FIRST_JOB);
  assert.equal(listed.artifact.path, undefined);
  assert.equal(listed.artifact.downloadUrl, `${PUBLIC_ORIGIN}/artifacts/${FIRST_JOB}`);
  assert.doesNotMatch(JSON.stringify(list), /erp\.example\.invalid|\/private\/path/);
  const failed = await client.callTool({
    name: 'erp_execute',
    arguments: { operation: 'jobs.status', params: { jobId: failedId } },
  });
  assert.equal(failed.isError, true);
  assert.doesNotMatch(failed.content[0].text, /erp\.example\.invalid|\/private\/path/);

  const download = await harness.handler(makeRequest(`/artifacts/${FIRST_JOB}`));
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/json');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal(await download.text(), '{"fixture":true}');
  assert.equal((await harness.handler(makeRequest(`/artifacts/${UNKNOWN_JOB}`))).status, 404);
  assert.equal((await harness.handler(makeRequest(`/artifacts/${SECOND_JOB}`))).status, 404);
  assert.equal((await harness.handler(makeRequest(`/artifacts/${incompleteId}`))).status, 404);
  const statusCount = harness.calls.statuses.length;
  assert.equal((await harness.handler(makeRequest(`/artifacts/${FIRST_JOB}`, { token: null }))).status, 401);
  assert.equal(harness.calls.statuses.length, statusCount, 'missing bearer auth is rejected before job ownership lookup');
});

test('private configuration, sessions, process lock, and Bun loopback binding are enforced', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-mcp-config-'));
  t.after(async () => { await fs.rm(rootDir, { recursive: true, force: true }); });
  const dataDir = path.join(rootDir, 'data');
  const configFile = path.join(rootDir, 'config.json');
  const tokenFile = path.join(rootDir, 'token');
  const sessionFile = path.join(rootDir, 'session.json');
  const config = { ...configFor(dataDir, rootDir), tokenFile, maxParallelExports: 4 };
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  await fs.writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  await fs.writeFile(sessionFile, JSON.stringify({ version: 1, ...session, userId: 12, expireTime: null }), { mode: 0o600 });
  assert.equal(readToken(tokenFile), TOKEN);
  assert.equal(readSession(sessionFile).username, session.username);
  assert.equal(loadConfig(configFile).publicUrl, PUBLIC_URL);
  assert.throws(() => validateConfig({ ...config, publicUrl: 'http://mcp.example.invalid/mcp' }));
  assert.throws(() => validateConfig({ ...config, publicUrl: 'https://user@mcp.example.invalid/mcp' }));
  assert.throws(() => validateConfig({ ...config, publicUrl: `${PUBLIC_URL}?token=secret` }));
  assert.throws(() => validateConfig({ ...config, sessionFiles: [sessionFile, sessionFile] }));
  assert.equal(validateConfig({ ...config, maxParallelExports: undefined }).maxParallelExports, 3);
  assert.equal(validateConfig({ ...config, sessionFiles: Array.from({ length: 40 }, (_, i) => path.join(rootDir, `${i}.json`)), maxParallelExports: 32 }).maxParallelExports, 32);
  for (const value of [0, -1, 33, 1.5, '4', null]) assert.throws(() => validateConfig({ ...config, maxParallelExports: value }));
  assert.throws(() => validateConfig({ ...config, poolScope: { auctionSite: 'OTHER', productTypeCate: '5' } }));

  const lock = await acquireProcessLock(dataDir);
  await assert.rejects(() => acquireProcessLock(dataDir), /process lock already exists/);
  await lock.release();
  const nextLock = await acquireProcessLock(dataDir);
  await nextLock.release();

  let serveOptions;
  let runtimeOptions;
  let runtimeClosed = 0;
  const service = await startHttpServer({
    env: { NEW_ERP_HTTP_CONFIG: configFile },
    bun: { serve(options) { serveOptions = options; return { stop() {} }; } },
    runtimeFactory: async options => { runtimeOptions = options; return {
      auth: { requireSession: () => session, status: () => ({ loggedIn: true }), async close() { runtimeClosed += 1; } },
      jobs: { async status() {}, async close() { runtimeClosed += 1; } },
      async close() { runtimeClosed += 1; },
    }; },
  });
  assert.equal(serveOptions.hostname, '127.0.0.1');
  assert.equal(serveOptions.port, 8443);
  assert.equal(runtimeOptions.maxParallelExports, 4);
  assert.equal(runtimeOptions.singleAccountDays, 31);
  assert.equal(runtimeOptions.salesCache.ttlSeconds, 900);
  for (const invalid of [{ singleAccountDays: 0 }, { salesCache: { ttlSeconds: -1 } }, { salesCache: { enabled: 'yes' } }]) {
    assert.throws(() => validateConfig({ ...config, ...invalid }));
  }
  await service.close();
  assert.equal(runtimeClosed, 1);
});
