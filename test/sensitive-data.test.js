const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const shared = require('../scripts/shared.js');

async function isolateConfig(t, config = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-redaction-test-'));
  const filename = path.join(directory, 'config.json');
  await fs.writeFile(filename, JSON.stringify(config));
  const keys = ['NEW_ERP_CONFIG', 'NEW_ERP_BASE_URL', 'NEW_ERP_USERNAME', 'NEW_ERP_PASSWORD', 'NEW_ERP_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { NEW_ERP_CONFIG: filename, NEW_ERP_BASE_URL: 'https://test.invalid',
    NEW_ERP_USERNAME: '', NEW_ERP_PASSWORD: '', NEW_ERP_TOKEN: '' });
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return filename;
}

test('API errors mask explicit request credentials, including encoded echoes', async (t) => {
  await isolateConfig(t);
  const username = 'demo-user@example.invalid';
  const password = 'fake-password/with space';
  const token = 'fake-secret-token';
  const echo = `${username} ${password} ${encodeURIComponent(password)} ${token}`;
  for (const status of [200, 401, 403]) {
    const mock = t.mock.method(global, 'fetch', async () => new Response(
      JSON.stringify({ code: status === 200 ? 0 : status, msg: `denied ${echo}` }), { status }));
    await assert.rejects(shared.requestJson('https://test.invalid/index.php', {
      headers: { token }, body: JSON.stringify({ username, password }),
    }), (error) => {
      assert.match(error.message, /denied/);
      for (const secret of [username, password, encodeURIComponent(password), token]) {
        assert.ok(!error.message.includes(secret));
      }
      return true;
    });
    mock.mock.restore();
  }
});

test('network errors redact bearer tokens and response bodies are omitted', async (t) => {
  await isolateConfig(t);
  const token = 'fake-bearer-value';
  const mock = t.mock.method(global, 'fetch', async () => {
    throw new Error(`network failure ${token}`, { cause: new Error(`Bearer ${token}`) });
  });
  await assert.rejects(shared.requestJson('https://test.invalid', {
    headers: { Authorization: `Bearer ${token}` },
  }), (error) => /network failure/.test(error.message) && !error.message.includes(token));
  mock.mock.restore();
  t.mock.method(global, 'fetch', async () => new Response('<html>private customer record</html>', { status: 502 }));
  await assert.rejects(shared.requestJson('https://test.invalid'), (error) => {
    assert.match(error.message, /non-JSON response: HTTP 502/);
    return !error.message.includes('private customer record');
  });
});

test('configuration errors never echo malformed JSON or embedded URL credentials', async (t) => {
  const filename = await isolateConfig(t);
  const privateValue = 'fake-config-secret';
  await fs.writeFile(filename, `{"password":"${privateValue}", BROKEN`);
  assert.throws(() => shared.getTokenFromArgs({}), (error) => {
    assert.match(error.message, /failed to read new-erp config/);
    return !error.message.includes(privateValue);
  });
  process.env.NEW_ERP_BASE_URL = `https://demo-user:${privateValue}@test.invalid`;
  assert.throws(() => shared.getBaseUrl(), (error) => {
    assert.match(error.message, /embedded credentials/);
    return !error.message.includes(privateValue);
  });
  process.env.NEW_ERP_BASE_URL = `invalid ${privateValue}`;
  assert.throws(() => shared.getBaseUrl(), (error) => !error.message.includes(privateValue));
});

test('configured credentials and common secret fields are masked in diagnostics', async (t) => {
  await isolateConfig(t, { username: 'fake-account', password: 'fake-config-password', token: 'fake-config-token' });
  const message = new shared.CommandExecutionError('failed fake-account fake-config-password fake-config-token').message;
  assert.equal(message, 'failed [REDACTED] [REDACTED] [REDACTED]');
  const redacted = shared.redactSensitiveText('password="unknown secret" token=unknown-token https://user:pass@test.invalid');
  for (const secret of ['unknown secret', 'unknown-token', 'user:pass']) assert.ok(!redacted.includes(secret));
});

test('product detail requires an explicit ID and CLI rejects positional secrets without echoing them', async (t) => {
  await isolateConfig(t);
  const api = await import('../index.mjs');
  await assert.rejects(api.productDetail({ token: 'test-token' }), /id must be a positive integer/);
  const result = spawnSync(process.execPath, ['scripts/product-detail.js', 'fake-positional-secret'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected positional argument/);
  assert.ok(!result.stderr.includes('fake-positional-secret'));
});
