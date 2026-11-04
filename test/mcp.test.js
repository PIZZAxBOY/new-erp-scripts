const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { saveSession, readSession, removeSession, sessionExpired } = require('../scripts/local-session.js');
const { getTokenFromArgs, getBaseUrl, withErpContext, requestJson } = require('../scripts/shared.js');
const root = path.resolve(__dirname, '..');

async function isolate(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-mcp-test-'));
  const keys = ['NEW_ERP_SESSION_FILE', 'NEW_ERP_CONFIG', 'NEW_ERP_BASE_URL', 'NEW_ERP_TOKEN', 'NEW_ERP_USERNAME', 'NEW_ERP_PASSWORD', 'NEW_ERP_EXPORT_DIR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.NEW_ERP_SESSION_FILE = path.join(directory, 'session.json');
  process.env.NEW_ERP_CONFIG = path.join(directory, 'config.json');
  process.env.NEW_ERP_EXPORT_DIR = path.join(directory, 'artifacts');
  await fs.writeFile(process.env.NEW_ERP_CONFIG, '{}');
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function payload(result) { return JSON.parse(result.content.find((item) => item.type === 'text').text); }

function execute(client, operation, params = {}, requestId) {
  return client.callTool({ name: 'erp_execute', arguments: { operation, params, ...(requestId ? { requestId } : {}) } });
}

async function memoryClient(t, options = {}) {
  const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
  const { createServer } = require('../scripts/mcp.js');
  const server = await createServer({ openBrowser: false, ...options });
  const client = new Client({ name: 'erp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('sessions do not cross ERP hosts, expired sessions fail, and contexts isolate concurrent requests', async (t) => {
  await isolate(t);
  const session = { baseUrl: 'https://one.invalid', username: 'one', token: 'token-one', expireTime: 4102444800 };
  saveSession(session);
  assert.equal(getBaseUrl(), session.baseUrl);
  assert.equal(getTokenFromArgs({}), session.token);
  process.env.NEW_ERP_BASE_URL = 'https://two.invalid';
  assert.throws(() => getTokenFromArgs({}), /does not match/);
  assert.equal(sessionExpired({ expireTime: 1 }), true);
  assert.equal(sessionExpired({ expireTime: '2000-01-01T00:00:00Z' }), true);
  assert.equal(sessionExpired({ expireTime: null }), false);
  saveSession({ ...session, expireTime: 1 });
  process.env.NEW_ERP_BASE_URL = session.baseUrl;
  assert.throws(() => getTokenFromArgs({}), /expired/);
  process.env.NEW_ERP_TOKEN = 'global-token';
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    await new Promise((resolve) => setImmediate(resolve));
    calls.push([url, options.headers.token, options.headers.Referer]);
    return new Response('{"code":200,"data":{}}');
  });
  await Promise.all(['alpha', 'beta'].map((name) => withErpContext({ baseUrl: `https://${name}.invalid`, token: name }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const token = getTokenFromArgs({ token: 'argument-token' });
    await requestJson(`${getBaseUrl()}/index.php`, { headers: { token } });
  })));
  assert.deepEqual(calls.sort(), [
    ['https://alpha.invalid/index.php', 'alpha', 'https://alpha.invalid/'],
    ['https://beta.invalid/index.php', 'beta', 'https://beta.invalid/'],
  ]);
  assert.throws(() => withErpContext({ baseUrl: session.baseUrl }, () => getTokenFromArgs({})), /auth\.login/);
});

test('MCP lists only ERP tools; no saved login never uses configured shared credentials', async (t) => {
  await isolate(t);
  process.env.NEW_ERP_TOKEN = 'shared-credential';
  process.env.NEW_ERP_BASE_URL = 'https://shared.invalid';
  const fetchMock = t.mock.method(global, 'fetch', async () => { throw new Error('unexpected request'); });
  const client = await memoryClient(t);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions();
  assert.ok(instructions.length <= 80, 'MCP startup instructions must stay short');
  assert.doesNotMatch(instructions, /request_secret|--browser/);
  assert.ok(tools.every((tool) => tool.description.length <= 90), 'Keep business tool descriptions concise');
  assert.deepEqual(tools.map((tool) => tool.name), ['erp_discover', 'erp_execute']);
  assert.ok(Buffer.byteLength(JSON.stringify({ instructions, tools })) <= 2000, 'Keep startup metadata within 2000 UTF-8 bytes');
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[1].annotations.readOnlyHint, false);
  assert.ok(tools.every((tool) => !['username', 'password', 'token'].some((key) => key in tool.inputSchema.properties)));
  const result = await execute(client, 'product_detail', { id: 12 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /auth\.login/);
  assert.match(result.content[0].text, /ERP 网址/);
  assert.match(result.content[0].text, /Agent 不查看或填写密码/);
  assert.match(result.content[0].text, /重试/);
  assert.equal(payload(result).error.next.arguments.operation, 'auth.login');
  assert.equal(fetchMock.mock.callCount(), 0);
  const asinResult = await execute(client, 'product_detail', { asin: 'B012345678' });
  assert.equal(asinResult.isError, true);
  assert.match(asinResult.content[0].text, /auth\.login/);
  assert.equal(fetchMock.mock.callCount(), 0);
  const invalid = await execute(client, 'product_detail', { id: -1 });
  assert.equal(invalid.isError, true);
  const injected = await execute(client, 'product_detail', { id: 12, token: 'injected-credential' });
  assert.equal(injected.isError, true);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('discovery covers every business capability and helpers without loading login state', async (t) => {
  await isolate(t);
  await fs.writeFile(process.env.NEW_ERP_CONFIG, '{broken');
  await fs.writeFile(process.env.NEW_ERP_SESSION_FILE, '{broken', { mode: 0o600 });
  const syncFs = require('node:fs');
  const original = syncFs.readFileSync;
  t.mock.method(syncFs, 'readFileSync', function (filename, ...args) {
    if ([process.env.NEW_ERP_CONFIG, process.env.NEW_ERP_SESSION_FILE].includes(filename)) throw new Error('Discovery must not read user state');
    return original.call(this, filename, ...args);
  });
  const fetchMock = t.mock.method(global, 'fetch', async () => { throw new Error('unexpected business request'); });
  const client = await memoryClient(t);
  const discovered = payload(await client.callTool({ name: 'erp_discover', arguments: {} }));
  assert.equal(discovered.operations.filter((operation) => !operation.name.includes('.')).length, 24);
  assert.equal(discovered.operations.length, 31);
  for (const operation of discovered.operations) {
    const description = payload(await client.callTool({ name: 'erp_discover', arguments: { operation: operation.name } }));
    assert.equal(description.name, operation.name);
    assert.equal(description.inputSchema.additionalProperties, false);
    for (const hidden of ['username', 'password', 'token', 'output']) assert.equal(hidden in description.inputSchema.properties, false);
  }
  for (const operation of ['constructor', '__proto__', 'erpClient', '/arbitrary/route']) {
    const result = await client.callTool({ name: 'erp_discover', arguments: { operation } });
    assert.equal(result.isError, true);
    assert.match(payload(result).error.message, /Unknown ERP operation/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('MCP browser login configures the current session and retries business work without restarting', async (t) => {
  await isolate(t);
  const client = await memoryClient(t);
  const password = 'browser-secret-password';
  const token = 'browser-secret-token';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.searchParams.get('r') === '/user/check-login') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        assert.deepEqual(JSON.parse(body), { username: 'browser-user', password });
        response.end(JSON.stringify({ code: 200, data: { token, user_id: 42 } }));
      });
    } else {
      assert.equal(request.headers.token, token);
      response.end(JSON.stringify({ code: 200, data: { product_basic_info: { id: 7, sku: 'FIXTURE-SKU', image_url: '/images/fixture.jpg' } } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const started = payload(await execute(client, 'auth.login'));
  assert.equal(started.state, 'login_pending');
  assert.equal(payload(await execute(client, 'auth.login')).url, started.url);
  const html = await (await fetch(started.url)).text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const response = await fetch(started.url, { method: 'POST', headers: {
    Origin: new URL(started.url).origin, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ csrf, baseUrl: `http://127.0.0.1:${server.address().port}`, username: 'browser-user', password }) });
  assert.equal(response.status, 200);
  const state = payload(await execute(client, 'auth.status'));
  assert.equal(state.loggedIn, true);
  const work = payload(await execute(client, 'product_detail', { id: 7 }));
  assert.equal(work.state, 'succeeded');
  assert.equal(work.result.data.list[0].sku, 'FIXTURE-SKU');
  assert.equal(payload(await execute(client, 'jobs.status', { jobId: work.jobId })).result.data.list[0].imageUrl, '/images/fixture.jpg');
  for (const value of [started, state, work]) for (const secret of [password, token]) assert.ok(!JSON.stringify(value).includes(secret));
  saveSession({ baseUrl: `http://127.0.0.1:${server.address().port}`, username: 'different-user', token: 'different-token', userId: 99 });
  const foreign = await execute(client, 'jobs.status', { jobId: work.jobId });
  assert.equal(payload(foreign).error.code, 'NOT_FOUND');
  assert.equal(payload(await execute(client, 'auth.logout')).loggedIn, false);
});

test('MCP product_detail searches ASIN inside the current user ERP and rejects conflicting selectors', async (t) => {
  await isolate(t);
  const asin = 'B012345678';
  const calls = [];
  saveSession({ baseUrl: 'https://own-erp.invalid', username: 'own-user', token: 'own-token', expireTime: 4102444800 });
  t.mock.method(global, 'fetch', async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://own-erp.invalid');
    assert.equal(options.headers.token, 'own-token');
    const route = url.searchParams.get('r'); calls.push(route);
    let data;
    if (route.endsWith('selected-option')) data = { other_select_name1_arr: { asin: 'ASIN' } };
    else if (route === '/products/product-basic/detail') data = { product_basic_info: { id: 42, sku: 'SKU-A', image_url: '/images/sku-a.jpg' } };
    else data = { page: 1, pageSize: 100, totalCount: 1, list: route.includes('jy-amazon')
      ? [{ id: 1, asin, sku: 'SKU-A' }] : [{ id: 42, sku: 'SKU-A' }] };
    return new Response(JSON.stringify({ code: 200, data }));
  });
  const client = await memoryClient(t);
  const result = await execute(client, 'product_detail', { asin });
  assert.equal(payload(result).state, 'succeeded');
  assert.equal(payload(result).result.data.list[0].asin, asin);
  assert.equal(payload(result).result.data.list[0].imageUrl, '/images/sku-a.jpg');
  assert.equal(calls.length, 4);
  const invalid = await execute(client, 'product_detail', { id: 42, asin });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 4);
});

test('MCP returns one JSON result using the saved user and handles session changes and expiry', async (t) => {
  await isolate(t);
  process.env.NEW_ERP_TOKEN = 'shared-token';
  process.env.NEW_ERP_BASE_URL = 'https://shared.invalid';
  const calls = [];
  let denied = false;
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push([url, options.headers.token]);
    if (denied) return new Response(JSON.stringify({ code: 401, msg: `login needed ${options.headers.token}` }), { status: 401 });
    return new Response(JSON.stringify({ code: 200, data: { product_basic_info: { id: 12, sku: 'SKU-ONE' } } }));
  });
  const client = await memoryClient(t);
  const session = { baseUrl: 'https://personal.invalid', username: 'account', token: 'private-token', expireTime: 4102444800 };
  saveSession(session);
  let result = await execute(client, 'product_detail', { id: 12 });
  assert.equal(payload(result).result.data.list[0].sku, 'SKU-ONE');
  assert.equal(payload(result).result.data.list[0].id, 12);
  assert.equal(result.structuredContent, undefined);
  saveSession({ ...session, baseUrl: 'https://second.invalid', token: 'second-token' });
  result = await execute(client, 'product_detail', { id: 12 });
  assert.equal(result.isError, undefined);
  assert.equal(new URL(calls[0][0]).origin, session.baseUrl);
  assert.equal(calls[0][1], session.token);
  assert.equal(new URL(calls[1][0]).origin, 'https://second.invalid');
  assert.equal(calls[1][1], 'second-token');
  denied = true;
  result = await execute(client, 'product_detail', { id: 12 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /auth\.login/);
  assert.ok(!JSON.stringify(result).includes('second-token'));
  saveSession({ ...session, expireTime: 1 });
  result = await execute(client, 'product_detail', { id: 12 });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 3);
  removeSession();
  result = await execute(client, 'erp_options', { source: 'inventory' });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 3);
});

test('real stdio client initializes and calls tools without non-protocol stdout', async (t) => {
  await isolate(t);
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'scripts/mcp.js')], env: { ...process.env }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 2);
    const result = await execute(client, 'inventory_list', { sku: 'SKU', stockCode: 'WH' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /auth\.login/);
  } finally { await client.close(); }
  assert.equal(stderr, '');
});
