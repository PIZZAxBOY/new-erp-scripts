const test = require('node:test');
const assert = require('node:assert/strict');
const { splitMonths, mergeParts, createPool } = require('../scripts/sales-account-pool.js');
const { getBaseUrl, getTokenFromArgs } = require('../scripts/shared.js');

test('splits full and partial months without overlap or missing seconds, including leap day', () => {
  const ranges = splitMonths('2024-01-15 13:00:00', '2024-04-07 11:12:13', 2);
  assert.deepEqual(ranges, [{ start: '2024-01-15 13:00:00', end: '2024-02-29 23:59:59' },
    { start: '2024-03-01 00:00:00', end: '2024-04-07 11:12:13' }]);
  assert.equal(splitMonths('2025-02-01', '2025-02-28', 3).length, 1);
  assert.throws(() => splitMonths('2025-02-30', '2025-03-31', 2));
});

const row = (sku, month, value) => ({ sku, sales_sum: value, mean: 99, statistics_rows: [{ date: month, value }] });
const first = rows => ({ start: '2025-01-01', end: '2025-01-31', rows });
const second = rows => ({ start: '2025-02-01', end: '2025-02-28', rows });

test('merges complete SKU union and periods, sums years without inventing mean', () => {
  const parts = [first([row('A', '2025-01', 7), row('B', '2025-01', 4)]), second([row('B', '2025-02', 6)])];
  const rows = mergeParts(parts, 'monthly');
  assert.equal(rows.find(r => r.sku === 'B').sales_sum, 10);
  assert.equal(rows[0].mean, null);
  assert.deepEqual(rows[0].statistics_rows, [{ date: '2025-01', value: 7 }, { date: '2025-02', value: 0 }]);
  assert.deepEqual(mergeParts(parts, 'yearly')[1].statistics_rows, [{ date: '2025', value: 10 }]);
});

test('rejects duplicates, wrong periods, subtotal mismatch, unsafe totals and overlap', () => {
  const r = row('A', '2025-01', 3);
  assert.throws(() => mergeParts([first([r, r])], 'monthly'), /duplicate SKU/);
  assert.throws(() => mergeParts([first([row('A', '2025-02', 3)])], 'monthly'), /unexpected CSV period/);
  assert.throws(() => mergeParts([first([{ ...r, sales_sum: 9 }])], 'monthly'), /subtotal mismatch/);
  assert.throws(() => mergeParts([first([r]), first([r])], 'monthly'), /overlapping/);
  assert.throws(() => mergeParts([first([row('A', '2025-01', Number.MAX_SAFE_INTEGER)]), second([row('A', '2025-02', 1)])], 'monthly'), /unsafe/);
});

function fixture(download) {
  let clock = 0;
  const accounts = [1, 2].map(i => ({ baseUrl: 'https://erp.example.com', token: `example-account-${i}` }));
  const submits = [];
  const load = createPool({ getSessions: () => accounts, scope: { auctionSite: 'JY', productTypeCate: '5' },
    now: () => clock, sleep: async ms => { clock += ms; }, download: async options => {
      await options.beforeSubmit();
      submits.push({ at: clock, token: getTokenFromArgs({}), baseUrl: getBaseUrl() });
      if (download) return download(options);
      const isFirst = options.start.startsWith('2025-01');
      return { file: Buffer.from('SKU,均值,小计,' + (isFirst ? '2025-01' : '2025-02') + '\nA,1,2,2\n'),
        taskId: isFirst ? 'one' : 'two', fileIdentity: isFirst ? 'one.csv' : 'two.csv' };
    } });
  return { load, submits };
}
const options = { start: '2025-01-01 00:00:00', end: '2025-02-28 23:59:59',
  query: { auction_site: 'JY', product_type_cate: '5', aggregate_by: 'sku', date_dimension: 'monthly' } };

test('isolates account context, staggers submissions and merges all data before pagination', async () => {
  const { load, submits } = fixture();
  const result = await load(options);
  assert.deepEqual(submits.map(s => s.at), [0, 3000]);
  assert.deepEqual(submits.map(s => s.token), ['example-account-1', 'example-account-2']);
  assert.equal(result.rows[0].sales_sum, 4); assert.equal(result.parts, 2);
});

test('validates period headers even when a segment has no SKU rows', async () => {
  const make = header => fixture(async options => {
    const first = options.start.startsWith('2025-01');
    return { taskId: first ? 'one' : 'two', fileIdentity: first ? 'one.csv' : 'two.csv',
      file: Buffer.from(first ? `SKU,小计,${header}\n` : 'SKU,小计,2025-02\nA,2,2\n') };
  });
  assert.equal((await make('2025年1月').load(options)).rows[0].sales_sum, 2);
  await assert.rejects(make('2025-02').load(options), /no partial ranking/);
  await assert.rejects(make('2025-01,2025年1月').load(options), /no partial ranking/);
});

test('fails closed on shared output file or any segment failure; mean sorting stays single-account', async () => {
  const shared = fixture(async options => ({ file: Buffer.from(`SKU,均值,小计,${options.start.slice(0, 7)}\nA,1,1,1\n`),
    taskId: 'x', fileIdentity: 'same.csv' }));
  await assert.rejects(shared.load(options), /output-file collision/);
  const broken = fixture(async () => { throw new Error('example-private-detail'); });
  await assert.rejects(broken.load(options), /no partial ranking/);
  const single = fixture(); await single.load(options, { sort: 'mean' }); assert.equal(single.submits.length, 1);
  const unverified = fixture(); await unverified.load({ ...options, query: { ...options.query, auction_site: 'YS' } });
  assert.equal(unverified.submits.length, 1);
});

test('remote runtime globally ranks all segments, persists results, and reuses requestId', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { createRemoteRuntime } = require('../scripts/mcp-remote-runtime.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-pool-'));
  const sessionFiles = [path.join(root, 'one.json'), path.join(root, 'two.json')];
  for (let i = 0; i < 2; i++) await fs.writeFile(sessionFiles[i], JSON.stringify({ version: 1,
    baseUrl: 'https://erp.example.com', token: `example-token-${i}`, username: `example-user-${i}`, userId: i + 1 }), { mode: 0o600 });
  const runtime = createRemoteRuntime({ rootDir: root, sessionFiles, poolScope: { auctionSite: 'JY', productTypeCate: '5' } });
  t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const calls = [];
  t.mock.method(require('../scripts/sales-volume-export.js'), 'downloadSalesCsv', async o => {
    calls.push(o);
    const jan = o.start.startsWith('2025-01');
    return { taskId: jan ? 'one' : 'two', fileIdentity: jan ? 'one.csv' : 'two.csv',
      file: Buffer.from(jan ? 'SKU,均值,小计,2025-01\nA,4,4,4\nB,6,6,6\n' : 'SKU,均值,小计,2025-02\nA,8,8,8\nC,5,5,5\n') };
  });
  const params = { startDate: '2025-01-01', endDate: '2025-02-28', auctionSite: 'JY', pageSize: 1 };
  const session = runtime.auth.requireSession();
  const receipt = await runtime.jobs.start('sales_volume_ranking', params, session, { requestId: 'one-ranking' });
  let done = receipt;
  for (let i = 0; i < 100 && ['running', 'queued'].includes(done.state); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    done = await runtime.jobs.status(receipt.jobId, session);
  }
  assert.equal(done.state, 'succeeded');
  const [top] = done.result.data.list;
  assert.equal(top.sku, 'A'); assert.equal(top.sales, 12); assert.equal(top.totalCount, 3);
  assert.equal(top.exportParts, 2); assert.equal(top.mean, null);
  assert.deepEqual(calls.map(c => c.token), ['example-token-0', 'example-token-1']);
  const retried = await runtime.jobs.start('sales_volume_ranking', params, session, { requestId: 'one-ranking' });
  assert.equal(retried.jobId, receipt.jobId); assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(runtime.auth.status()), /example-token|example-user/);
});

test('remote runtime requires distinct, unexpired administrator sessions', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { createRemoteRuntime } = require('../scripts/mcp-remote-runtime.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-runtime-auth-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const writeSession = async (filename, values) => fs.writeFile(filename, JSON.stringify({
    version: 1,
    baseUrl: 'https://erp.example.com',
    token: `example-token-${filename}`,
    username: 'example-user',
    userId: 1,
    expireTime: 4102444800,
    ...values,
  }), { mode: 0o600 });

  const duplicateFiles = [path.join(root, 'one.json'), path.join(root, 'two.json')];
  await Promise.all(duplicateFiles.map(filename => writeSession(filename)));
  const duplicate = createRemoteRuntime({ rootDir: root, sessionFiles: duplicateFiles });
  assert.throws(() => duplicate.auth.requireSession(), error => error.code === 'LOGIN_REQUIRED');
  assert.equal(duplicate.auth.status().state, 'login_required');
  await duplicate.close();

  const expiredFile = path.join(root, 'expired.json');
  await writeSession(expiredFile, { username: 'expired-user', expireTime: 1 });
  const expired = createRemoteRuntime({ rootDir: root, sessionFiles: [expiredFile] });
  assert.throws(() => expired.auth.requireSession(), error => error.code === 'LOGIN_REQUIRED');
  assert.equal(expired.auth.status().state, 'login_required');
  await expired.close();
});
