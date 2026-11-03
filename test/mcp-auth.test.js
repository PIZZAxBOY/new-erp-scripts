const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createAuth } = require('../scripts/mcp-auth.js');

async function isolate(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-mcp-auth-'));
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

test('MCP starts a private login page immediately and reuses one pending attempt', async (t) => {
  await isolate(t);
  const auth = createAuth({ openBrowser: false });
  t.after(() => auth.close());
  assert.equal(auth.status().loggedIn, false);
  assert.throws(() => auth.requireSession(), { code: 'LOGIN_REQUIRED' });
  const login = await auth.login();
  assert.equal(login.state, 'login_pending');
  assert.equal((await auth.login()).url, login.url);
  assert.equal(auth.status().url, login.url);
  const password = 'fixture-private-password';
  const token = 'fixture-private-token';
  const erp = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      assert.deepEqual(JSON.parse(body), { username: 'fixture-user', password });
      response.end(JSON.stringify({ code: 200, data: { token } }));
    });
  });
  await new Promise((resolve) => erp.listen(0, '127.0.0.1', resolve));
  t.after(() => { erp.closeAllConnections(); erp.close(); });
  const page = await (await fetch(login.url)).text();
  const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const response = await fetch(login.url, { method: 'POST', headers: {
    Origin: new URL(login.url).origin, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ csrf, baseUrl: `http://127.0.0.1:${erp.address().port}`, username: 'fixture-user', password }) });
  assert.equal(response.status, 200);
  assert.equal(auth.requireSession().token, token);
  const status = auth.status();
  assert.equal(status.loggedIn, true);
  for (const output of [login, status]) {
    assert.ok(!JSON.stringify(output).includes(password));
    assert.ok(!JSON.stringify(output).includes(token));
  }
  assert.equal((await auth.logout()).loggedIn, false);
  await assert.rejects(fetch(login.url));
});

test('damaged saved state does not block the browser form, and logout closes it', async (t) => {
  await isolate(t);
  await fs.writeFile(process.env.NEW_ERP_SESSION_FILE, '{broken', { mode: 0o600 });
  await fs.writeFile(process.env.NEW_ERP_CONFIG, '{broken');
  const auth = createAuth({ openBrowser: false });
  t.after(() => auth.close());
  assert.equal(auth.status().loggedIn, false);
  const login = await auth.login();
  assert.equal((await fetch(login.url)).status, 200);
  assert.equal((await auth.logout()).loggedIn, false);
  await assert.rejects(fetch(login.url));
  await assert.rejects(fs.access(process.env.NEW_ERP_SESSION_FILE), { code: 'ENOENT' });
});
