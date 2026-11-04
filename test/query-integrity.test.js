const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { withErpContext } = require('../scripts/shared.js');
const { matchingTask } = require('../scripts/sales-volume-export.js');

const json = (data) => new Response(JSON.stringify({ code: 200, data }));
const context = (operation) => withErpContext({ baseUrl: 'https://audit.invalid', token: 'fixture-token' }, operation);
const dates = { startDate: '2026-01-01', endDate: '2026-01-31' };
const start = '2026-01-01 00:00:00', end = '2026-01-31 23:59:59';
const query = { mode: 'sku', aggregate_by: 'sku', date_dimension: 'monthly',
  date_range: `${start} & ${end}`, index: 'sales-volume' };
const route = '/statistics/sales-volume/download-list';
const task = (id, status = '3', params = query) => ({ id, status,
  route_url: route.slice(1), start_date: start, end_date: end,
  add_condition: JSON.stringify({ params }), error_reason: 'fixture failure' });

test('batch products reject malformed and truncated pages instead of returning not-found', async (t) => {
  const api = await import('../index.mjs');
  let data;
  t.mock.method(global, 'fetch', async () => json(data));
  await context(async () => {
    for (data of [{}, { list: [] }, { list: [], totalCount: null },
      { list: [], totalCount: 1 }, { list: [null], totalCount: 1 },
      { page: 2, pageSize: 20, list: [{ id: 1, sku: 'ABC' }], totalCount: 1 }]) {
      await assert.rejects(api.gameProductBatch({ skus: 'ABC' }), /pagination/);
    }
    data = { page: 1, pageSize: 20, list: [], totalCount: 0 };
    const empty = await api.gameProductBatch({ skus: 'ABC' });
    assert.equal(empty[0].found, false);
    assert.equal(empty[0].totalCount, 0);
    data = { list: [{ id: 1, sku: 'ABC' }], totalCount: '1' };
    const found = await api.gameProductBatch({ skus: 'ABC' });
    assert.equal(found[0].found, true);
    assert.equal(found[0].totalCount, 1);
  });
});

test('single-page sales ranking validates page metadata and expected row count before assigning ranks', async (t) => {
  const api = await import('../index.mjs');
  const rows = [{ sku: 'A', sales_sum: 5 }, { sku: 'B', sales_sum: 4 }];
  let data;
  t.mock.method(global, 'fetch', async () => json(data));
  await context(async () => {
    for (data of [
      { page: 1, pageSize: 2, totalCount: 4, list: rows },
      { page: 2, pageSize: 10, totalCount: 4, list: rows },
      { page: 2, pageSize: 2, totalCount: 4, list: rows.slice(0, 1) },
      { page: 2, pageSize: 2, totalCount: null, list: rows },
    ]) await assert.rejects(api.salesVolumeRanking({ ...dates, source: 'list', page: 2, pageSize: 2 }), /pagination/);
    data = { page: 2, pageSize: 2, totalCount: 4, list: rows };
    assert.deepEqual((await api.salesVolumeRanking({ ...dates, source: 'list', page: 2, pageSize: 2 })).map(row => row.rank), [3, 4]);
    data = { totalCount: 3, list: rows.slice(0, 1) };
    assert.deepEqual((await api.salesVolumeRanking({ ...dates, source: 'list', page: 2, pageSize: 2 })).map(row => row.rank), [3]);
  });
});

test('explicit list sales ranking defaults to top-level materials and Top 10 reads only one page', async (t) => {
  const api = await import('../index.mjs');
  const queries = [];
  t.mock.method(global, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get('r'), '/statistics/sales-volume/list');
    queries.push(url.searchParams);
    return json({ page: 1, pageSize: 10, totalCount: 6276,
      list: Array.from({ length: 10 }, (_, i) => ({ sku: `SKU-${i}`, sales_sum: 100 - i })) });
  });
  await context(async () => {
    for (const [options, expectedType] of [[{}, '5'], [{ productTypeCate: '6' }, '6'], [{ productTypeCate: '' }, null]]) {
      const before = queries.length;
      const rows = await api.salesVolumeRanking({ ...dates, source: 'list', auctionSite: 'JY', pageSize: 10, ...options });
      assert.equal(queries.length, before + 1);
      const query = queries.at(-1);
      assert.equal(query.get('product_type_cate'), expectedType);
      assert.equal(query.get('auction_site'), 'JY');
      assert.equal(query.get('page'), '1');
      assert.equal(query.get('pageSize'), '10');
      assert.equal(rows.length, 10);
      assert.equal(rows[0].sales, 100);
      assert.equal(rows.at(-1).rank, 10);
    }
    const before = queries.length;
    await assert.rejects(api.salesVolumeRanking({ ...dates, productTypeCate: 'invalid' }), /productTypeCate/);
    assert.equal(queries.length, before);
  });
});

for (const oldStatus of ['3', '4']) {
  test(`sales export creates a fresh task instead of reusing historical status=${oldStatus}`, async (t) => {
    const api = await import('../index.mjs');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-fresh-sales-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const output = path.join(directory, 'sales.csv');
    let submissions = 0;
    const old = task('old', oldStatus);
    t.mock.method(global, 'fetch', async (input) => {
      const url = new URL(input);
      const current = url.searchParams.get('r');
      if (current === '/settings/download-center/index') return json({ list: submissions ? [old, task('new')] : [old] });
      if (current === route) { submissions++; return json({}); }
      assert.equal(current, '/settings/download-center/download-file');
      assert.equal(url.searchParams.get('id'), 'new');
      return new Response('sku,sales\nABC,5\n', { headers: { 'content-disposition': 'attachment; filename=sales.csv' } });
    });
    const result = await context(() => api.salesVolumeExport({ ...dates, output }));
    assert.equal(submissions, 1);
    assert.equal(result[0].taskId, 'new');
    assert.equal(await fs.readFile(output, 'utf8'), 'sku,sales\nABC,5\n');
  });
}

test('sales export task selection excludes old IDs, other routes and extra filters, and rejects ambiguity', () => {
  const previous = new Set(['old']);
  const unrelated = { ...task('other'), route_url: 'unrelated/export' };
  const filtered = task('filtered', '3', { ...query, sku: 'restricted' });
  assert.equal(matchingTask([task('old'), unrelated, filtered], query, start, end, previous), undefined);
  assert.equal(matchingTask([task('old'), task('new')], query, start, end, previous).id, 'new');
  assert.throws(() => matchingTask([task('new-1'), task('new-2')], query, start, end, previous), /multiple matching/);
});

test('sales export does not resubmit after an ambiguous submission error when a new task exists', async (t) => {
  const api = await import('../index.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-uncertain-sales-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let submissions = 0;
  t.mock.method(global, 'fetch', async (input) => {
    const current = new URL(input).searchParams.get('r');
    if (current === '/settings/download-center/index') return json({ list: submissions ? [task('new', '4')] : [] });
    assert.equal(current, route);
    submissions++;
    throw new Error('fixture connection interrupted after submission');
  });
  await context(() => assert.rejects(api.salesVolumeExport({ ...dates, output: path.join(directory, 'sales.csv') }), /fixture failure/));
  assert.equal(submissions, 1);
});
