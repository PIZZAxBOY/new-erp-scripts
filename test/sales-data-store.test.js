const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSalesDataStore, normalizeDataConfig } = require('../scripts/sales-data-store.js');
const { monthLabels } = require('../scripts/sales-account-pool.js');

const context = { identity: { accounts: ['one', 'two'] }, allowRangeReuse: true };
const options = (start, end) => ({ start: start + ' 00:00:00', end: end + ' 23:59:59', query: {
  aggregate_by: 'sku', date_dimension: 'monthly', auction_site: 'JY', product_type_cate: '5',
  date_range: `${start} 00:00:00 & ${end} 23:59:59`,
} });

function exported(request, taskId = '1', factor = 1) {
  const from = Date.parse(request.start.replace(' ', 'T') + 'Z');
  const until = Date.parse(request.end.replace(' ', 'T') + 'Z') + 1000;
  const rows = ['A', 'B'].map(sku => {
    const statistics_rows = monthLabels(request.start, request.end).map(date => {
      const start = new Date(date + '-01T00:00:00Z');
      const end = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
      const days = (Math.min(end, until) - Math.max(start.getTime(), from)) / 86400000;
      return { date, value: sku === 'B' && date < '2024-02' ? 0 : days * factor * (sku === 'A' ? 1 : 2) };
    });
    return { sku, mean: 1, sales_sum: statistics_rows.reduce((sum, p) => sum + p.value, 0), statistics_rows };
  }).filter(row => row.sales_sum > 0);
  return { taskId, rows };
}

async function fixture(t, config) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sales-data-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const calls = [];
  const download = async request => { calls.push([request.start, request.end]); return exported(request, String(calls.length)); };
  return { rootDir, calls, download, storage: createSalesDataStore({ rootDir, config }) };
}

const comparable = result => result.rows.map(r => [r.sku, r.sales_sum, r.statistics_rows]).sort((a, b) => a[0].localeCompare(b[0]));

test('permanent snapshots survive new instances and time; contained full months use local data only', async t => {
  const f = await fixture(t), whole = options('2024-01-01', '2024-03-31'), feb = options('2024-02-01', '2024-02-29');
  const first = await f.storage.load(whole, context, f.download);
  assert.equal(first.cache.hit, false);
  const reopened = createSalesDataStore({ rootDir: f.rootDir, now: () => Date.now() + 365 * 86400000 });
  const exact = await reopened.load(whole, context, f.download);
  assert.equal(exact.cache.hit, true);
  const subset = await reopened.load(feb, context, f.download);
  assert.equal(f.calls.length, 1);
  assert.equal(subset.localData.mode, 'assembled');
  assert.equal(subset.rows[0].mean, null);
  assert.deepEqual(comparable(subset), comparable(exported(feb)));
  const jan = await reopened.load(options('2024-01-01', '2024-01-31'), context, f.download);
  assert.deepEqual(jan.rows.map(r => r.sku), ['A']);
});

test('partial-month requests are exported exactly, not prorated from month totals', async t => {
  const f = await fixture(t);
  await f.storage.load(options('2024-01-01', '2024-03-31'), context, f.download);
  const partial = options('2024-01-10', '2024-03-20');
  const result = await f.storage.load(partial, context, f.download);
  assert.deepEqual(f.calls.slice(1), [['2024-01-10 00:00:00', '2024-01-31 23:59:59'], ['2024-03-01 00:00:00', '2024-03-20 23:59:59']]);
  assert.equal(result.localData.mode, 'mixed');
  assert.deepEqual(comparable(result), comparable(exported(partial)));
});

test('adjacent same-month fragments merge without overlap; narrower ranges still require export', async t => {
  const f = await fixture(t);
  await f.storage.load(options('2024-01-01', '2024-01-15'), context, f.download);
  await f.storage.load(options('2024-01-16', '2024-01-31'), context, f.download);
  const whole = options('2024-01-01', '2024-01-31');
  const result = await f.storage.load(whole, context, f.download);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(comparable(result), comparable(exported(whole)));
  await f.storage.load(options('2024-01-03', '2024-01-04'), context, f.download);
  assert.equal(f.calls.length, 3);
});

test('new overlapping snapshots supersede old fragments without deleting historical versions', async t => {
  const f = await fixture(t), whole = options('2024-01-01', '2024-01-31');
  await f.storage.load(whole, context, f.download);
  const middle = options('2024-01-10', '2024-01-20');
  await f.storage.load(middle, { ...context, forceRefresh: true }, async r => exported(r, 'new', 2));
  const result = await f.storage.load(whole, context, f.download);
  assert.deepEqual(f.calls.slice(1), [['2024-01-01 00:00:00', '2024-01-09 23:59:59'], ['2024-01-21 00:00:00', '2024-01-31 23:59:59']]);
  assert.equal(result.rows[0].sales_sum, 42);
  const [family] = await fs.readdir(path.join(f.rootDir, '.sales-data'));
  const files = await fs.readdir(path.join(f.rootDir, '.sales-data', family));
  assert.equal(files.filter(file => file.endsWith('.gz')).length, 4);
});

test('failed refresh invalidates old coverage but retains snapshots; failed gap cannot return partial ranking', async t => {
  const f = await fixture(t), whole = options('2024-01-01', '2024-01-31');
  await f.storage.load(whole, context, f.download);
  await assert.rejects(f.storage.load(whole, { ...context, forceRefresh: true }, async () => { throw Error('ERP failed'); }), /ERP failed/);
  const retry = await f.storage.load(whole, context, f.download);
  assert.equal(retry.cache.hit, false);
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.storage.load(options('2024-01-01', '2024-03-31'), context, async () => { throw Error('missing segment failed'); }), /missing segment failed/);
});

test('identity and epoch are isolated; signed and zero-total data are exact-only', async t => {
  const f = await fixture(t), whole = options('2024-01-01', '2024-01-31');
  await f.storage.load(whole, context, f.download);
  await f.storage.load(whole, { ...context, identity: { accounts: ['other'] } }, f.download);
  await createSalesDataStore({ rootDir: f.rootDir, config: { epoch: 'new' } }).load(whole, context, f.download);
  assert.equal(f.calls.length, 3);
  await f.storage.load(whole, { ...context, forceRefresh: true }, async r => {
    const result = exported(r, 'signed');
    for (const row of result.rows) { row.sales_sum *= -1; for (const period of row.statistics_rows) period.value *= -1; }
    return result;
  });
  const signed = await f.storage.load(whole, context, f.download);
  assert.equal(signed.cache.hit, true);
  assert.equal(signed.rows[0].sales_sum, -31);
  await f.storage.load(options('2024-01-01', '2024-01-15'), context, f.download);
  assert.equal(f.calls.length, 4);
});

test('concurrent identical requests export once; quota never evicts; corruption fails closed', async t => {
  const f = await fixture(t), whole = options('2024-01-01', '2024-01-31');
  await Promise.all([f.storage.load(whole, context, f.download), f.storage.load(whole, context, f.download)]);
  assert.equal(f.calls.length, 1);
  await assert.rejects(createSalesDataStore({ rootDir: f.rootDir, config: { maxBytes: 1024 } }).load(options('2024-02-01', '2024-02-29'), context, f.download), /capacity/);
  const directory = path.join(f.rootDir, '.sales-data', (await fs.readdir(path.join(f.rootDir, '.sales-data')))[0]);
  const blob = (await fs.readdir(directory)).find(file => file.endsWith('.gz'));
  await fs.writeFile(path.join(directory, blob), 'corrupt');
  await assert.rejects(f.storage.load(whole, context, f.download));
  assert.equal(f.calls.length, 1);
});

test('symlink directory rejected; invalid config rejected', async t => {
  const f = await fixture(t), external = await fs.mkdtemp(path.join(os.tmpdir(), 'external-sales-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.symlink(external, path.join(f.rootDir, '.sales-data'));
  await assert.rejects(f.storage.load(options('2024-01-01', '2024-01-31'), context, f.download), /Unsafe/);
  assert.equal(f.calls.length, 0);
  for (const config of [{ enabled: 'yes' }, { maxBytes: -1 }, { minFreeBytes: -1 }, { ttlSeconds: 1 }]) {
    assert.throws(() => normalizeDataConfig(config), /Invalid/);
  }
});
