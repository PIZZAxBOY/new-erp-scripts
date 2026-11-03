const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
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
  const keys = ['NEW_ERP_SESSION_FILE', 'NEW_ERP_CONFIG', 'NEW_ERP_BASE_URL', 'NEW_ERP_TOKEN', 'NEW_ERP_USERNAME', 'NEW_ERP_PASSWORD'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.NEW_ERP_SESSION_FILE = path.join(directory, 'session.json');
  process.env.NEW_ERP_CONFIG = path.join(directory, 'config.json');
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

function runCli(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/new-erp.js'), ...args], { env, cwd: root });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function memoryClient(t) {
  const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
  const { createServer } = require('../scripts/mcp.js');
  const server = await createServer();
  const client = new Client({ name: 'erp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('npm login saves only a private token, CLI reuses it, logout removes it', async (t) => {
  await isolate(t);
  const password = 'fake-login-password';
  const token = 'fake-login-token';
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.searchParams.get('r') === '/user/check-login') {
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { username: 'account-one', password });
      response.end(JSON.stringify({ code: 200, data: { token, user_id: 10, expire_time: 4102444800 } }));
    } else {
      assert.equal(request.headers.token, token);
      response.end(JSON.stringify({ code: 200, data: { product_basic_info: { id: 12, sku: 'DEMO-ONE', image_url: 'https://example.invalid/image.jpg' } } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const result = await runCli(['login', '--baseUrl', baseUrl, '--username', 'account-one'],
    { ...process.env, NEW_ERP_PASSWORD: password });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).loggedIn, true);
  assert.ok(!(result.stdout + result.stderr).includes(token));
  assert.ok(!(result.stdout + result.stderr).includes(password));
  const saved = await fs.readFile(process.env.NEW_ERP_SESSION_FILE, 'utf8');
  assert.ok(!saved.includes(password));
  assert.equal(JSON.parse(saved).baseUrl, baseUrl);
  assert.equal(readSession().token, token);
  if (process.platform !== 'win32') assert.equal((await fs.stat(process.env.NEW_ERP_SESSION_FILE)).mode & 0o777, 0o600);
  const detail = await runCli(['product-detail', '--id', '12']);
  assert.equal(detail.status, 0, detail.stderr);
  assert.equal(JSON.parse(detail.stdout)[0].sku, 'DEMO-ONE');
  assert.equal((await runCli(['logout'])).status, 0);
  assert.equal(readSession(), null);
});

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
  assert.throws(() => withErpContext({ baseUrl: session.baseUrl }, () => getTokenFromArgs({})), /login first/);
});

test('MCP lists only ERP tools; no saved login never uses configured shared credentials', async (t) => {
  await isolate(t);
  process.env.NEW_ERP_TOKEN = 'shared-credential';
  process.env.NEW_ERP_BASE_URL = 'https://shared.invalid';
  const fetchMock = t.mock.method(global, 'fetch', async () => { throw new Error('unexpected request'); });
  const client = await memoryClient(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['game_product_list', 'product_detail', 'inventory_list', 'erp_options']);
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint));
  assert.ok(tools.every((tool) => !['username', 'password', 'token'].some((key) => key in tool.inputSchema.properties)));
  const result = await client.callTool({ name: 'product_detail', arguments: { id: 12 } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /new-erp login/);
  assert.equal(fetchMock.mock.callCount(), 0);
  const asinResult = await client.callTool({ name: 'product_detail', arguments: { asin: 'B012345678' } });
  assert.equal(asinResult.isError, true);
  assert.match(asinResult.content[0].text, /new-erp login/);
  assert.equal(fetchMock.mock.callCount(), 0);
  const invalid = await client.callTool({ name: 'product_detail', arguments: { id: -1 } });
  assert.equal(invalid.isError, true);
  const injected = await client.callTool({ name: 'product_detail', arguments: { id: 12, token: 'injected-credential' } });
  assert.equal(injected.isError, true);
  assert.equal(fetchMock.mock.callCount(), 0);
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
  const result = await client.callTool({ name: 'product_detail', arguments: { asin } });
  assert.equal(result.structuredContent.list[0].asin, asin);
  assert.equal(result.structuredContent.list[0].imageUrl, '/images/sku-a.jpg');
  assert.equal(calls.length, 4);
  const invalid = await client.callTool({ name: 'product_detail', arguments: { id: 42, asin } });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 4);
});

test('MCP returns structured data using the current saved user and handles session changes and expiry', async (t) => {
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
  let result = await client.callTool({ name: 'product_detail', arguments: { id: 12 } });
  assert.equal(result.structuredContent.list[0].sku, 'SKU-ONE');
  assert.equal(JSON.parse(result.content[0].text).list[0].id, 12);
  saveSession({ ...session, baseUrl: 'https://second.invalid', token: 'second-token' });
  result = await client.callTool({ name: 'product_detail', arguments: { id: 12 } });
  assert.equal(result.isError, undefined);
  assert.equal(new URL(calls[0][0]).origin, session.baseUrl);
  assert.equal(calls[0][1], session.token);
  assert.equal(new URL(calls[1][0]).origin, 'https://second.invalid');
  assert.equal(calls[1][1], 'second-token');
  denied = true;
  result = await client.callTool({ name: 'product_detail', arguments: { id: 12 } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /new-erp login/);
  assert.ok(!JSON.stringify(result).includes('second-token'));
  saveSession({ ...session, expireTime: 1 });
  result = await client.callTool({ name: 'product_detail', arguments: { id: 12 } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 3);
  removeSession();
  result = await client.callTool({ name: 'erp_options', arguments: { source: 'inventory' } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 3);
});

test('real stdio client initializes and calls tools without non-protocol stdout', async (t) => {
  await isolate(t);
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'scripts/new-erp.js'), 'mcp'], env: { ...process.env }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 4);
    const result = await client.callTool({ name: 'inventory_list', arguments: { sku: 'SKU', stockCode: 'WH' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /new-erp login/);
  } finally { await client.close(); }
  assert.equal(stderr, '');
});

test('Codex setup uses the installed absolute Node/server paths and dry-run leaves config alone', async (t) => {
  const directory = await isolate(t);
  const { main: setup } = require('../scripts/setup.js');
  const command = await setup({ dryRun: true });
  assert.equal(command.command, 'codex');
  assert.deepEqual(command.args, ['mcp', 'add', 'new-erp', '--', process.execPath, path.join(root, 'scripts/mcp.js')]);
  await assert.rejects(setup({ client: 'other' }), /client/);
  await assert.rejects(setup({ name: '--bad' }), /name/);
  if (process.platform === 'win32') return;
  const fake = path.join(directory, 'codex');
  const record = path.join(directory, 'arguments.json');
  await fs.writeFile(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ERP_TEST_ARGS, JSON.stringify({args:process.argv.slice(2),token:process.env.NEW_ERP_TOKEN}));`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/setup.js'), '--client', 'codex'], {
    env: { ...process.env, NEW_ERP_TOKEN: 'must-not-forward', ERP_TEST_ARGS: record,
      PATH: `${directory}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const recorded = JSON.parse(await fs.readFile(record, 'utf8'));
  assert.deepEqual(recorded.args, command.args);
  assert.equal(recorded.token, undefined);
});
