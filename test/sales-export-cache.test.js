const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSalesCache, normalizeCacheConfig } = require('../scripts/sales-export-cache.js');

const options = { start: '2024-01-31 00:00:00', end: '2024-02-01 23:59:59', query: {
  aggregate_by: 'sku', date_dimension: 'monthly', auction_site: 'JY', product_type_cate: '5',
  date_range: '2024-01-31 00:00:00 & 2024-02-01 23:59:59',
} };
const csv = 'SKU,均值,小计,2024-01,2024-02\nA,2,4,1,3\nB,1,2,2,0\n';

async function fixture(t, config) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-cache-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let clock = 100000, calls = 0;
  const create = () => createSalesCache({ rootDir, config, now: () => clock });
  const download = async () => { calls++; return { file: Buffer.from(csv), taskId: String(calls) }; };
  return { rootDir, create, download, calls: () => calls, advance: ms => { clock += ms; } };
}

test('persists all rows, survives recreation, isolates scope and refreshes without stale fallback', async t => {
  const f = await fixture(t, { ttlSeconds: 30 });
  const cache = f.create(), scope = { identity: { owner: 'one' } };
  const first = await cache.load(options, scope, f.download);
  assert.equal(first.cache.hit, false); assert.equal(first.rows.length, 2);
  first.rows[0].sales_sum = 999;
  const hit = await f.create().load(options, scope, f.download);
  assert.equal(hit.cache.hit, true); assert.equal(hit.rows[0].sales_sum, 4); assert.equal(f.calls(), 1);
  await cache.load(options, { identity: { owner: 'two' } }, f.download);
  assert.equal(f.calls(), 2);
  await cache.load({ ...options, query: { ...options.query, product_type_cate: '6' } }, scope, f.download);
  assert.equal(f.calls(), 3);
  await assert.rejects(cache.load(options, { ...scope, forceRefresh: true }, async () => { throw new Error('ERP unavailable'); }), /ERP unavailable/);
  assert.equal((await cache.load(options, scope, f.download)).cache.hit, false);
  f.advance(30001);
  assert.equal((await cache.load(options, scope, f.download)).cache.hit, false);
  assert.equal(f.calls(), 5);
});

test('serializes identical cache fills, applies limits, removes corruption and rejects symlink directories', async t => {
  const f = await fixture(t, { maxEntries: 1, maxBytes: 8192 });
  const cache = f.create();
  const results = await Promise.all([cache.load(options, { identity: 'a' }, f.download), cache.load(options, { identity: 'a' }, f.download)]);
  assert.deepEqual(results.map(r => r.cache.hit), [false, true]); assert.equal(f.calls(), 1);
  await cache.load(options, { identity: 'b' }, f.download);
  assert.equal((await cache.load(options, { identity: 'a' }, f.download)).cache.hit, false);
  const dir = path.join(f.rootDir, '.sales-cache'), names = await fs.readdir(dir);
  assert.equal(names.length, 1);
  const file = path.join(dir, names[0]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.writeFile(file, '{}');
  assert.equal((await cache.load(options, { identity: 'a' }, f.download)).cache.hit, false);
  const external = path.join(f.rootDir, 'external');
  await fs.writeFile(external, 'untouched'); await fs.unlink(file); await fs.symlink(external, file);
  assert.equal((await cache.load(options, { identity: 'a' }, f.download)).cache.hit, false);
  assert.equal(await fs.readFile(external, 'utf8'), 'untouched');
  await fs.rm(dir, { recursive: true }); await fs.mkdir(path.join(f.rootDir, 'other'));
  await fs.symlink(path.join(f.rootDir, 'other'), dir);
  await assert.rejects(cache.load(options, { identity: 'a' }, f.download), /Unsafe/);
});

test('only caches validated complete results and respects byte budget and disabled mode', async t => {
  const f = await fixture(t, { maxBytes: 1024 });
  const cache = f.create();
  for (const text of ['SKU,小计,2024-01\nA,1,1\n', csv + 'A,2,4,1,3\n', csv.replace('A,2,4', 'A,2,9')]) {
    await assert.rejects(cache.load(options, {}, async () => ({ file: Buffer.from(text), taskId: 'invalid' })));
  }
  const large = csv + Array.from({ length: 50 }, (_, i) => `SKU${i},1,2,1,1\n`).join('');
  const result = await cache.load(options, {}, async () => ({ file: Buffer.from(large), taskId: 'large' }));
  assert.equal(result.cache.stored, false); assert.equal((await fs.readdir(path.join(f.rootDir, '.sales-cache'))).length, 0);
  const disabled = createSalesCache({ rootDir: f.rootDir, config: { enabled: false } });
  assert.equal((await disabled.load(options, {}, f.download)).cache, undefined);
  assert.equal((await disabled.load(options, {}, f.download)).cache, undefined);
  for (const value of [null, { ttlSeconds: 0 }, { maxBytes: -1 }, { enabled: 'true' }, { maxEntries: 0 }, { mystery: true }]) assert.throws(() => normalizeCacheConfig(value));
});

test('remote ranking reuses complete cache across pages but checks authentication and refresh', async t => {
  const f = await fixture(t);
  const sessionFile = path.join(f.rootDir, 'session.json');
  const session = { version: 1, baseUrl: 'https://erp.example.com', token: 'example-token', username: 'example-user', userId: 1 };
  await fs.writeFile(sessionFile, JSON.stringify(session), { mode: 0o600 });
  const { createRemoteRuntime } = require('../scripts/mcp-remote-runtime.js');
  const runtime = createRemoteRuntime({ rootDir: f.rootDir, sessionFiles: [sessionFile], poolScope: { auctionSite: 'JY', productTypeCate: '5' } });
  t.after(() => runtime.close());
  t.mock.method(require('../scripts/sales-volume-export.js'), 'downloadSalesCsv', f.download);
  const params = { startDate: '2024-01-31', endDate: '2024-02-01', auctionSite: 'JY', pageSize: 1 };
  async function run(p, requestId) {
    let job = await runtime.jobs.start('sales_volume_ranking', p, runtime.auth.requireSession(), { requestId });
    for (let i = 0; i < 100 && ['running', 'queued'].includes(job.state); i++) {
      await new Promise(resolve => setTimeout(resolve, 10)); job = await runtime.jobs.status(job.jobId, session);
    }
    assert.equal(job.state, 'succeeded', JSON.stringify(job.error)); return job;
  }
  const first = await run(params, 'first');
  assert.equal(first.result.data.list[0].sku, 'A'); assert.equal(first.result.data.list[0].cache.hit, false);
  const second = await run({ ...params, page: 2 }, 'second');
  assert.equal(second.result.data.list[0].sku, 'B'); assert.equal(second.result.data.list[0].cache.hit, true); assert.equal(f.calls(), 1);
  const refresh = await run({ ...params, forceRefresh: true }, 'refresh');
  assert.equal(refresh.result.data.list[0].cache.hit, false); assert.equal(f.calls(), 2);
  await run({ ...params, forceRefresh: true }, 'refresh'); assert.equal(f.calls(), 2);
  await fs.writeFile(sessionFile, JSON.stringify({ ...session, expireTime: 1 }), { mode: 0o600 });
  assert.throws(() => runtime.auth.requireSession(), /administrator/);
});
