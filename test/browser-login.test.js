const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runBrowserLogin } = require('../scripts/login-browser.js');
const { readSession, saveSession } = require('../scripts/local-session.js');

async function isolate(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-browser-test-'));
  const keys = ['NEW_ERP_SESSION_FILE', 'NEW_ERP_CONFIG', 'NEW_ERP_BASE_URL', 'NEW_ERP_USERNAME', 'NEW_ERP_PASSWORD', 'NEW_ERP_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.NEW_ERP_SESSION_FILE = path.join(directory, 'session.json');
  process.env.NEW_ERP_CONFIG = path.join(directory, 'config.json');
  await fs.writeFile(process.env.NEW_ERP_CONFIG, '{}');
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function fakeErp(t, onLogin) {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => onLogin(JSON.parse(body), response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function start(t, options = {}) {
  const controller = new AbortController();
  let ready;
  const url = new Promise((resolve) => { ready = resolve; });
  const done = runBrowserLogin({ openBrowser: false, signal: controller.signal, ...options, onReady: ready });
  done.catch(() => {});
  t.after(async () => { controller.abort(); await done.catch(() => {}); });
  return { url: await url, done, controller };
}

async function form(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin',
    'native same-origin form submissions must retain their Origin');
  const html = await response.text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf);
  return { csrf, html };
}

function post(url, fields, headers = {}) {
  return fetch(url, { method: 'POST', redirect: 'error', headers: {
    Origin: new URL(url).origin, 'Content-Type': 'application/x-www-form-urlencoded', ...headers,
  }, body: new URLSearchParams(fields) });
}

test('browser login configures URL, account and password in one page without secret output', async (t) => {
  await isolate(t);
  process.env.NEW_ERP_PASSWORD = 'environment-password-must-not-be-used';
  const password = 'browser-password';
  const token = 'browser-token';
  const baseUrl = await fakeErp(t, (credentials, response) => {
    assert.deepEqual(credentials, { username: 'browser-user', password });
    response.end(JSON.stringify({ code: 200, data: { token, user_id: 42 } }));
  });
  const login = await start(t);
  const { csrf, html } = await form(login.url);
  for (const name of ['baseUrl', 'username', 'password']) assert.ok(html.includes(`name="${name}"`));
  assert.match(html, /type="password"/);
  assert.ok(!html.includes(process.env.NEW_ERP_PASSWORD));
  const response = await post(login.url, { csrf, baseUrl, username: 'browser-user', password });
  assert.equal(response.status, 200);
  const success = await response.text();
  assert.match(success, /登录成功/);
  await login.done;
  assert.equal(readSession().token, token);
  const saved = await fs.readFile(process.env.NEW_ERP_SESSION_FILE, 'utf8');
  assert.ok(!saved.includes(password));
  if (process.platform !== 'win32') assert.equal((await fs.stat(process.env.NEW_ERP_SESSION_FILE)).mode & 0o777, 0o600);
  for (const content of [html, success]) {
    assert.ok(!content.includes(password));
    assert.ok(!content.includes(token));
  }
  await assert.rejects(fetch(login.url));
});

test('browser login rejects forged requests and escapes editable defaults without ERP calls', async (t) => {
  await isolate(t);
  let calls = 0;
  const baseUrl = await fakeErp(t, (credentials, response) => {
    calls++;
    response.end(JSON.stringify({ code: 401 }));
  });
  const login = await start(t, { defaults: { username: '"><script>unsafe</script>' } });
  const { csrf, html } = await form(login.url);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>unsafe'));
  const fields = { csrf, baseUrl, username: 'fixture', password: 'fixture-password' };
  for (const headers of [{ Origin: 'https://foreign.invalid' }, { Origin: 'null' }, { Origin: '' }]) {
    assert.equal((await post(login.url, fields, headers)).status, 403);
  }
  const forgedHost = await new Promise((resolve, reject) => {
    const request = http.get(login.url, { headers: { Host: 'foreign.invalid' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('error', reject);
  });
  assert.equal(forgedHost, 403);
  assert.equal((await fetch(`${login.url}?extra=1`)).status, 404);
  assert.equal((await post(login.url, { ...fields, csrf: 'wrong' })).status, 403);
  assert.equal((await post(login.url, { ...fields, extra: 'unexpected' })).status, 400);
  assert.equal((await post(login.url, `${new URLSearchParams(fields)}&username=duplicate`)).status, 400);
  assert.equal((await post(login.url, fields, { 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await post(login.url, { ...fields, password: '' })).status, 400);
  assert.equal((await post(login.url, { ...fields, password: 'x'.repeat(20_000) })).status, 413);
  assert.equal(calls, 0);
  assert.equal(readSession(), null);
});

test('browser login can reopen configuration even when the previous session file is damaged', async (t) => {
  await isolate(t);
  await fs.writeFile(process.env.NEW_ERP_SESSION_FILE, '{broken', { mode: 0o600 });
  const login = await start(t);
  const { csrf } = await form(login.url);
  assert.equal((await post(`${login.url}/cancel`, { csrf })).status, 200);
  await assert.rejects(login.done, /网页登录已取消/);
  assert.throws(() => readSession(), /auth\.login/);
});

test('failed browser authentication preserves the old session and allows a clean retry', async (t) => {
  await isolate(t);
  saveSession({ baseUrl: 'https://old.invalid', username: 'old-user', token: 'old-token' });
  const previous = await fs.readFile(process.env.NEW_ERP_SESSION_FILE, 'utf8');
  const baseUrl = await fakeErp(t, ({ password }, response) => {
    response.end(JSON.stringify(password === 'correct-password'
      ? { code: 200, data: { token: 'new-token' } }
      : { code: 401, msg: `rejected ${password}` }));
  });
  const login = await start(t);
  const { csrf } = await form(login.url);
  const first = await post(login.url, { csrf, baseUrl, username: 'new-user', password: 'rejected-password' });
  assert.equal(first.status, 401);
  const retry = await first.text();
  assert.ok(!retry.includes('rejected-password'));
  assert.match(retry, /重试/);
  assert.equal(await fs.readFile(process.env.NEW_ERP_SESSION_FILE, 'utf8'), previous);
  const second = await post(login.url, { csrf, baseUrl, username: 'new-user', password: 'correct-password' });
  assert.equal(second.status, 200);
  assert.equal((await login.done).loggedIn, true);
  assert.equal(readSession().token, 'new-token');
  await assert.rejects(fetch(login.url));
});

test('canceling a pending browser login aborts ERP work and prevents a late session write', async (t) => {
  await isolate(t);
  let acknowledge;
  const started = new Promise((resolve) => { acknowledge = resolve; });
  const baseUrl = await fakeErp(t, (credentials, response) => acknowledge(response));
  const login = await start(t);
  const { csrf } = await form(login.url);
  const submitting = post(login.url, { csrf, baseUrl, username: 'fixture', password: 'fixture-password' });
  submitting.catch(() => {});
  const pending = await started;
  assert.equal((await post(login.url, { csrf, baseUrl, username: 'fixture', password: 'fixture-password' })).status, 409);
  const disconnected = new Promise((resolve) => pending.once('close', resolve));
  const canceled = await post(`${login.url}/cancel`, { csrf });
  assert.equal(canceled.status, 200);
  assert.match(await canceled.text(), /已取消/);
  await assert.rejects(login.done, /取消/);
  await disconnected;
  pending.end(JSON.stringify({ code: 200, data: { token: 'too-late-token' } }));
  await submitting.catch(() => {});
  assert.equal(readSession(), null);
  await assert.rejects(fetch(login.url));
});

test('browser login expiry closes its listener without changing the session', async (t) => {
  await isolate(t);
  const login = await start(t, { timeoutMs: 100 });
  await assert.rejects(login.done, /过期/);
  assert.equal(readSession(), null);
  await assert.rejects(fetch(login.url));
});

test('browser login reports storage failure without leaking credentials or leaving its listener open', async (t) => {
  const directory = await isolate(t);
  process.env.NEW_ERP_SESSION_FILE = path.join(directory, 'session-directory');
  await fs.mkdir(process.env.NEW_ERP_SESSION_FILE);
  const baseUrl = await fakeErp(t, (credentials, response) => {
    response.end(JSON.stringify({ code: 200, data: { token: 'unsaved-private-token' } }));
  });
  const login = await start(t);
  const { csrf } = await form(login.url);
  const response = await post(login.url, { csrf, baseUrl, username: 'fixture', password: 'fixture-password' });
  assert.equal(response.status, 500);
  const html = await response.text();
  assert.ok(!html.includes('fixture-password'));
  assert.ok(!html.includes('unsaved-private-token'));
  await assert.rejects(login.done, /保存/);
  await assert.rejects(fetch(login.url));
  assert.equal((await fs.stat(process.env.NEW_ERP_SESSION_FILE)).isDirectory(), true);
});
