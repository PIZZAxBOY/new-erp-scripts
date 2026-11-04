const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { parseSalesCsv } = require('../scripts/sales-volume-csv.js');
const { main: ranking } = require('../scripts/sales-volume-ranking.js');
const { withErpContext } = require('../scripts/shared.js');
const { createJobs } = require('../scripts/mcp-jobs.js');
const { getOperation } = require('../scripts/mcp-catalog.js');

const dates = { startDate: '2020-01-01', endDate: '2026-10-31' };
const session = { baseUrl: 'https://csv.invalid', token: 'fixture-token', username: 'fixture-user' };
const json = (data) => new Response(JSON.stringify({ code: 200, data }));
const attachment = (text) => new Response(text, { headers: { 'content-disposition': 'attachment; filename=sales.csv' } });

// Synthetic contracts, not samples captured from an authenticated ERP account.
function exportFixture(t, csv, { status = '3', download } = {}) {
  const submissions = [];
  const tasks = [];
  const downloads = [];
  t.mock.method(global, 'fetch', async (input) => {
    const query = new URL(input).searchParams;
    const route = query.get('r');
    if (route === '/settings/download-center/index') return json({ list: tasks });
    if (route === '/settings/download-center/download-file') {
      downloads.push(query.get('id'));
      return download ? download() : attachment(csv);
    }
    assert.equal(route, '/statistics/sales-volume/download-list', 'must not request the slow list endpoint');
    const params = Object.fromEntries(query);
    delete params.r;
    submissions.push(params);
    const [start, end] = params.date_range.split(' & ');
    tasks.push({ id: submissions.length, status, route_url: route.slice(1), start_date: start, end_date: end,
      add_condition: JSON.stringify({ params }), error_reason: 'fixture-token failed' });
    return json({});
  });
  return { submissions, downloads };
}

test('CSV parses BOM, quotes, CRLF, multiline, numeric totals and GBK without inventing values', () => {
  const [row] = parseSalesCsv(Buffer.from('\uFEFFSKU,品名,小计,均值,2026-01\r\n001,"中,文""名\r\n第二行","1,234",2.5,7\r\n'));
  assert.equal(row.sku, '001');
  assert.equal(row.name_cn, '中,文"名\r\n第二行');
  assert.equal(row.sales_sum, 1234);
  assert.equal(row.mean, 2.5);
  assert.deepEqual(row.statistics_rows, [{ date: '2026-01', value: 7 }]);
  const gbk = Buffer.concat([Buffer.from('sku,name_cn,sales_sum\nA,'), Buffer.from('d6d0cec4', 'hex'), Buffer.from(',9\n')]);
  assert.equal(parseSalesCsv(gbk)[0].name_cn, '中文');
  assert.equal(parseSalesCsv(gbk)[0].mean, null);
});

test('CSV rejects unsupported, ambiguous, truncated and invalid data instead of plausible rankings', () => {
  for (const csv of ['', '<html>login</html>', 'SKU,2026-01\nA,2', 'SKU,小计,销量\nA,1,2',
    'SKU,小计,SKU\nA,1,A', 'SKU,小计\nA', 'SKU,小计\nA,', 'SKU,小计\nA,NaN',
    'SKU,小计\nA,9007199254740992', 'SKU,小计\nA,"1,2"', 'SKU,小计\n,3', 'SKU,小计\nA,"3']) {
    assert.throws(() => parseSalesCsv(Buffer.from(csv)), /sales CSV/);
  }
  assert.throws(() => parseSalesCsv(Buffer.from('SKU,小计\nA,2'), { aggregateBy: 'sku-platform' }), /platform/);
  assert.deepEqual(parseSalesCsv(Buffer.from('SKU,小计\n')), []);
});

test('long-range ranking defaults to one filtered CSV export, sorts globally, then pages', async (t) => {
  const fixture = exportFixture(t, '项目,SKU,品名,小计,均值\nJY,C,丙,10,2\nJY,A,甲,30,3\nJY,B,乙,30,4\n');
  const result = await withErpContext(session, () => ranking({ ...dates, auctionSite: 'EXR', page: 2, pageSize: 1, raw: true }));
  assert.deepEqual(fixture.submissions, [{ mode: 'sku', aggregate_by: 'sku', date_dimension: 'monthly',
    date_range: '2020-01-01 00:00:00 & 2026-10-31 23:59:59', index: 'sales-volume', auction_site: 'JY', product_type_cate: '5' }]);
  assert.deepEqual(fixture.downloads, ['1']);
  assert.deepEqual(result.map(({ sku, sales, rank, totalCount, source, taskId }) => ({ sku, sales, rank, totalCount, source, taskId })),
    [{ sku: 'B', sales: 30, rank: 2, totalCount: 3, source: 'export', taskId: '1' }]);
  assert.equal(JSON.parse(result[0].rawJson).csv['小计'], '30');
  const ascending = await withErpContext(session, () => ranking({ ...dates, sort: 'mean', order: 'asc', pageSize: 1 }));
  assert.equal(ascending[0].sku, 'C');
});

test('CSV ranking preserves explicit material types, platform and yearly filters and exact SKU selection', async (t) => {
  const fixture = exportFixture(t, '项目,SKU,平台,小计\nJY,ABC,Amazon,3\nJY,ABCD,Amazon,90\nJY,ABC,Shopify,5\n');
  for (const type of ['6', '']) {
    const rows = await withErpContext(session, () => ranking({ ...dates, sku: 'ABC', aggregateBy: 'sku-platform',
      auctionSiteType: 'Amazon,Shopify', dateDimension: 'yearly', productTypeCate: type, pageSize: 1 }));
    assert.deepEqual(rows.map((row) => [row.sku, row.sales, row.totalCount]), [['ABC', 5, 2], ['ABC', 3, 2]]);
    assert.equal(fixture.submissions.at(-1).product_type_cate, type || undefined);
    assert.equal(fixture.submissions.at(-1).date_dimension, 'yearly');
    assert.equal(fixture.submissions.at(-1).auction_site_type, 'Amazon,Shopify');
    assert.equal(fixture.submissions.at(-1).sku, 'ABC');
  }
});

test('CSV duplicate and empty results fail, and failed exports are not returned as success', async (t) => {
  exportFixture(t, 'SKU,小计\nA,1\nA,2');
  await assert.rejects(withErpContext(session, () => ranking(dates)), /duplicate/);
  t.mock.restoreAll();
  exportFixture(t, 'SKU,小计\n');
  await assert.rejects(withErpContext(session, () => ranking(dates)), /No SKU sales/);
  t.mock.restoreAll();
  const fixture = exportFixture(t, '', { status: '4' });
  await assert.rejects(withErpContext(session, () => ranking(dates)), (error) => /failed/.test(error.message) && !error.message.includes(session.token));
  assert.deepEqual(fixture.downloads, []);
});

test('MCP ranking returns a running receipt during CSV download and requestId reuses the same job', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sales-csv-jobs-'));
  let release;
  let reached;
  const waiting = new Promise((resolve) => { reached = resolve; });
  const download = new Promise((resolve) => { release = resolve; });
  const fixture = exportFixture(t, '', { download: () => { reached(); return download; } });
  const jobs = createJobs({ rootDir, getOperation, waitMs: 0 });
  t.after(async () => { release(attachment('SKU,小计\nA,5')); await jobs.close(); await fs.rm(rootDir, { recursive: true, force: true }); });
  await assert.rejects(jobs.start('sales_volume_ranking', dates, session), /stable requestId/);
  const started = await jobs.start('sales_volume_ranking', dates, session, { requestId: 'range-top' });
  await waiting;
  const running = await jobs.status(started.jobId, session);
  assert.equal(running.state, 'running');
  assert.equal(running.progress.stage, 'downloading');
  const retry = await jobs.start('sales_volume_ranking', dates, session, { requestId: 'range-top' });
  assert.equal(retry.jobId, started.jobId);
  assert.equal(fixture.submissions.length, 1);
  release(attachment('SKU,小计\nA,5'));
  let result;
  for (let i = 0; i < 100; i += 1) {
    result = await jobs.status(started.jobId, session);
    if (result.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(result.state, 'succeeded');
  assert.equal(result.result.data.list[0].sales, 5);
});
