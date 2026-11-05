const test = require('node:test');
const assert = require('node:assert/strict');
const { splitMonths, mergeParts, createPool } = require('../scripts/sales-account-pool.js');
const { getBaseUrl, getTokenFromArgs } = require('../scripts/shared.js');

test('splits full and partial months without overlap or missing seconds, including leap day', () => {
  const ranges = splitMonths('2024-01-15 13:00:00', '2024-04-07 11:12:13', 2);
  assert.deepEqual(ranges, [{ start: '2024-01-15 13:00:00', end: '2024-02-29 23:59:59' },
    { start: '2024-03-01 00:00:00', end: '2024-04-07 11:12:13' }]);
  assert.equal(splitMonths('2025-02-01', '2025-02-28', 3).length, 1);
  assert.deepEqual(splitMonths('2024-01-31', '2024-02-01', 2), [{ start: '2024-01-31 00:00:00', end: '2024-02-01 23:59:59' }]);
  assert.equal(splitMonths('2024-05-20', '2024-07-10', 2).length, 1);
  assert.equal(splitMonths('2024-01-01', '2024-02-29', 2, 60).length, 1);
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

function fixture(download, { count = 2, maxParallelExports, scope = { auctionSite: 'JY', productTypeCate: '5' } } = {}) {
  let clock = 0;
  const accounts = Array.from({ length: count }, (_, i) => ({ baseUrl: 'https://erp.example.com', token: `example-account-${i + 1}` }));
  const submits = [];
  const load = createPool({ getSessions: () => accounts, scope,
    maxParallelExports,
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

test('larger pools obey the configured limit, account count and month count', async () => {
  for (const [limit, count, months, parts] of [[undefined, 6, 12, 3], [4, 6, 12, 4], [32, 6, 2, 2], [32, 4, 12, 4], [32, 40, 36, 32]]) {
    const { load, submits } = fixture(async o => {
      await Promise.resolve();
      const labels = [];
      for (let month = new Date(o.start.slice(0, 7) + '-01T00:00:00Z'); month.toISOString().slice(0, 7) <= o.end.slice(0, 7); month.setUTCMonth(month.getUTCMonth() + 1)) {
        labels.push(month.toISOString().slice(0, 7));
      }
      return { taskId: o.start, fileIdentity: o.start + '.csv',
        file: Buffer.from(`SKU,小计,${labels.join(',')}\nA,${labels.length},${labels.map(() => 1).join(',')}\n`) };
    }, { count, maxParallelExports: limit });
    const end = new Date(Date.UTC(2023, months, 0)).toISOString().slice(0, 10) + ' 23:59:59';
    const result = await load({ ...options, start: '2023-01-01 00:00:00', end });
    assert.equal(result.parts, parts);
    assert.equal(result.rows[0].sales_sum, months);
    assert.equal(result.rows[0].statistics_rows.length, months);
    assert.deepEqual(submits.map(s => s.at), Array.from({ length: parts }, (_, i) => i * 3000));
    assert.equal(new Set(submits.map(s => s.token)).size, parts);
  }
  for (const value of [0, -1, 33, 1.5, '4', null, Infinity]) {
    assert.throws(() => fixture(undefined, { maxParallelExports: value }), /maxParallelExports/);
  }
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
  await assert.rejects(broken.load(options), (error) => {
    assert.match(error.message, /no partial ranking/);
    assert.doesNotMatch(error.message, /example-private-detail/);
    return true;
  });
  const single = fixture(); await single.load(options, { sort: 'mean' }); assert.equal(single.submits.length, 1);
  const otherSite = fixture();
  await otherSite.load({ ...options, query: { ...options.query, auction_site: 'YS', catalog_id: '9', sku: 'A' } });
  assert.equal(otherSite.submits.length, 2);
  const disabled = fixture(undefined, { scope: null });
  await disabled.load(options);
  assert.equal(disabled.submits.length, 1);
});

test('splits sku-platform and platform aggregates without collapsing identities', async () => {
  const platform = fixture(async options => {
    const month = options.start.slice(0, 7);
    return { taskId: month, fileIdentity: `${month}.csv`, file: Buffer.from(`平台,小计,${month}\nAmazon,2,2\n`) };
  });
  const platformResult = await platform.load({ ...options, query: { ...options.query, aggregate_by: 'platform' } });
  assert.equal(platformResult.parts, 2);
  assert.equal(platformResult.rows[0].auction_site_type, 'Amazon');
  assert.equal(platformResult.rows[0].sales_sum, 4);
  const split = fixture(async options => {
    const month = options.start.slice(0, 7);
    const value = month.endsWith('01') ? 3 : 5;
    return { taskId: month, fileIdentity: `${month}.csv`,
      file: Buffer.from(`sku,平台,小计,${month}\nA,Amazon,${value},${value}\nA,Shopify,1,1\n`) };
  });
  const rows = (await split.load({ ...options, query: { ...options.query, aggregate_by: 'sku-platform' } })).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.auction_site_type === 'Amazon').sales_sum, 8);
  assert.equal(rows.find(row => row.auction_site_type === 'Shopify').sales_sum, 2);
});

test('remote runtime globally ranks all segments, persists results, and reuses requestId', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { createRemoteRuntime } = require('../scripts/mcp-remote-runtime.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-pool-'));
  const sessionFiles = Array.from({ length: 4 }, (_, i) => path.join(root, `${i}.json`));
  for (let i = 0; i < 4; i++) await fs.writeFile(sessionFiles[i], JSON.stringify({ version: 1,
    baseUrl: 'https://erp.example.com', token: `example-token-${i}`, username: `example-user-${i}`, userId: i + 1 }), { mode: 0o600 });
  const runtime = createRemoteRuntime({ rootDir: root, sessionFiles, maxParallelExports: 4, poolScope: { auctionSite: 'JY', productTypeCate: '5' } });
  t.after(async () => { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const calls = [];
  t.mock.method(require('../scripts/sales-volume-export.js'), 'downloadSalesCsv', async o => {
    calls.push(o);
    const month = o.start.slice(0, 7), index = Number(month.slice(-2)) - 1;
    const value = [4, 8, 1, 2][index];
    return { taskId: month, fileIdentity: month + '.csv',
      file: Buffer.from(`SKU,均值,小计,${month}\nA,1,${value},${value}\n` + (index === 0 ? 'B,6,6,6\n' : index === 1 ? 'C,5,5,5\n' : '')) };
  });
  const params = { startDate: '2025-01-01', endDate: '2025-04-30', auctionSite: 'JY', pageSize: 1 };
  const session = runtime.auth.requireSession();
  const receipt = await runtime.jobs.start('sales_volume_ranking', params, session, { requestId: 'one-ranking' });
  let done = receipt;
  for (let i = 0; i < 400 && ['running', 'queued'].includes(done.state); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    done = await runtime.jobs.status(receipt.jobId, session);
  }
  assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
  const [top] = done.result.data.list;
  assert.equal(top.sku, 'A'); assert.equal(top.sales, 15); assert.equal(top.totalCount, 3);
  assert.equal(top.exportParts, 4); assert.equal(top.mean, null);
  assert.deepEqual(calls.map(c => c.token), ['example-token-0', 'example-token-1', 'example-token-2', 'example-token-3']);
  const retried = await runtime.jobs.start('sales_volume_ranking', params, session, { requestId: 'one-ranking' });
  assert.equal(retried.jobId, receipt.jobId); assert.equal(calls.length, 4);
  const covered = await runtime.jobs.start('sales_volume_ranking', {
    startDate: '2025-02-01', endDate: '2025-02-28', auctionSite: 'JY', pageSize: 10,
  }, session, { requestId: 'february-from-disk' });
  let month = covered;
  for (let i = 0; i < 400 && ['running', 'queued'].includes(month.state); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    month = await runtime.jobs.status(covered.jobId, session);
  }
  assert.equal(month.state, 'succeeded', JSON.stringify(month.error));
  assert.equal(month.result.data.list[0].sales, 8);
  assert.equal(calls.length, 4);
  assert.equal(runtime.auth.status().maxParallelExports, 4);
  assert.doesNotMatch(JSON.stringify(runtime.auth.status()), /example-token|example-user/);

  const exported = await runtime.jobs.start('sales_volume_export', {
    startDate: '2025-01-01', endDate: '2025-04-30',
  }, session, { requestId: 'csv-export' });
  let csvJob = exported;
  for (let i = 0; i < 400 && ['running', 'queued'].includes(csvJob.state); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    csvJob = await runtime.jobs.status(exported.jobId, session);
  }
  assert.equal(csvJob.state, 'succeeded');
  assert.equal(csvJob.result.encoding, 'UTF-8');
  const csv = await fs.readFile(csvJob.result.artifact.path, 'utf8');
  assert.match(csv, /^sku,小计,2025-01,2025-02,2025-03,2025-04\nA,15,4,8,1,2\n/);
  assert.equal(calls.length, 8);
  const again = await runtime.jobs.start('sales_volume_export', {
    startDate: '2025-02-01', endDate: '2025-03-31',
  }, session, { requestId: 'csv-from-disk' });
  let reused = again;
  for (let i = 0; i < 400 && ['running', 'queued'].includes(reused.state); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    reused = await runtime.jobs.status(again.jobId, session);
  }
  assert.equal(reused.state, 'succeeded', JSON.stringify(reused.error));
  assert.equal(calls.length, 8);

  const { writeTable, readTable } = require('../scripts/xlsx-merge.js');
  t.mock.method(require('../scripts/packing-detail-export.js'), 'main', async (options) => options.accountSplit({
    start: '2025-01-01 00:00:00', end: '2025-04-30 23:59:59', query: { scan_date: 'full' },
    run: async (range) => ({ file: writeTable([['box', 'qty'], [range.start.slice(0, 7), '1']]), boxes: 1, taskId: range.start, query: {} }),
  }));
  const packing = await runtime.jobs.start('packing_detail_export', {
    project: 'JY', warehouses: 'DEMO-DEST', startDate: '2025-01-01', endDate: '2025-04-30',
  }, session, { requestId: 'packing-export' });
  let packed = packing;
  for (let i = 0; i < 400 && ['running', 'queued'].includes(packed.state); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    packed = await runtime.jobs.status(packing.jobId, session);
  }
  assert.equal(packed.state, 'succeeded');
  assert.equal(packed.result.boxes, 4);
  assert.deepEqual(readTable(await fs.readFile(packed.result.artifact.path)), [
    ['box', 'qty'], ['2025-01', '1'], ['2025-02', '1'], ['2025-03', '1'], ['2025-04', '1'],
  ]);
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
