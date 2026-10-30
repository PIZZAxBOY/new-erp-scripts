const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');

test('market orders use the read-only ERP route and retain raw records and metadata', async (t) => {
  const { marketOrderList } = await import('new-erp-scripts');
  const calls = [];
  const rows = [1, 2, 3].map((id) => ({ id: String(id), transaction_id: 'DEMO-TX',
    sku_qty: [{ sku: 'DEMO-SKU', qty: '2' }], order_status: '0', track_number: '',
    product_all_info: [{ sku: 'DEMO-SKU', sale_price: '1.2500' }], commission: null }));
  let mode = '';
  const server = http.createServer((request, response) => {
    const query = new URL(request.url, `http://${request.headers.host}`).searchParams;
    calls.push({ method: request.method, token: request.headers.token, query });
    if (mode === 'denied') {
      response.writeHead(403);
      response.end(JSON.stringify({ code: 403, msg: 'no permission' }));
      return;
    }
    const page = Number(query.get('page'));
    const pageSize = Number(query.get('pageSize'));
    const list = mode === 'empty' ? [] : rows.slice((page - 1) * pageSize, page * pageSize);
    if (mode === 'duplicate' && page > 1) list[0] = rows[0];
    if (mode === 'missing-id') list[0] = { sku_qty: [] };
    const data = { page, pageSize, totalCount: mode === 'empty' ? 0 : mode === 'changed-total' && page > 1 ? 4 : 3,
      list: mode === 'short-page' ? [] : list, order_status_map: { 0: '示例状态' } };
    response.end(JSON.stringify({ code: 200, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NEW_ERP_BASE_URL;
  process.env.NEW_ERP_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (previous === undefined) delete process.env.NEW_ERP_BASE_URL;
    else process.env.NEW_ERP_BASE_URL = previous;
    await new Promise((resolve) => server.close(resolve));
  });
  const options = { token: 'test-token', pageSize: 2 };

  await t.test('defaults, filters, full pagination and single-page completeness', async () => {
    const first = await marketOrderList({ token: 'test-token' });
    assert.equal(first.page, 1);
    assert.equal(first.pageSize, 20);
    assert.equal(calls[0].query.get('order_status'), '');
    assert.equal(calls[0].query.has('search_type'), false);
    const result = await marketOrderList({ ...options, fetchAll: true, searchType: '6', searchValue: 'DEMO-SKU',
      project: 'DEMO', status: 0, transactionId: 'DEMO-TX' });
    assert.deepEqual(result.list, rows);
    assert.equal(result.totalCount, 3);
    assert.equal(result.fetchedCount, 3);
    assert.equal(result.complete, true);
    assert.deepEqual(result.order_status_map, { 0: '示例状态' });
    assert.deepEqual(result.source.query, { order_status: '0', search_type: '6', search_value: 'DEMO-SKU',
      auction_site: 'DEMO', transaction_id: 'DEMO-TX', page: 1, pageSize: 2 });
    assert.ok(!JSON.stringify(result.source).includes('test-token'));
    assert.ok(calls.every(({ method, token, query }) => method === 'GET' && token === 'test-token'
      && query.get('r') === '/marketing/market-order/index'));
    assert.equal((await marketOrderList(options)).complete, false);
    assert.equal((await marketOrderList({ ...options, page: 2 })).complete, false);
    const searched = await marketOrderList({ ...options, searchValue: '1', status: '-1' });
    assert.equal(searched.source.query.search_type, '3');
    assert.equal(searched.source.query.order_status, '-1');
  });

  await t.test('invalid input fails before any request', async () => {
    for (const input of [{ searchType: '7', searchValue: 'x' }, { searchType: '3' }, { searchValue: '' },
      { project: '' }, { status: 'bad' }, { transactionId: '' }, { pageSize: 101 },
      { fetchAll: true, page: 2 }, { fetchAll: 'true' }]) {
      const before = calls.length;
      await assert.rejects(marketOrderList({ ...options, ...input }));
      assert.equal(calls.length, before);
    }
  });

  await t.test('pagination, missing IDs and permission failures are not empty results', async () => {
    await assert.rejects(marketOrderList({ ...options, fetchAll: true, maxPages: 1 }), /exceeding/);
    for (const [scenario, error] of [['duplicate', /duplicate/], ['changed-total', /pagination|totalCount/],
      ['short-page', /pagination/], ['missing-id', /without an id/], ['denied', /403|permission/]]) {
      mode = scenario;
      await assert.rejects(marketOrderList({ ...options, fetchAll: true }), error);
    }
    mode = 'empty';
    const empty = await marketOrderList({ ...options, fetchAll: true });
    assert.deepEqual(empty.list, []);
    assert.equal(empty.totalCount, 0);
    assert.equal(empty.complete, true);
    mode = '';
  });

  await t.test('CLI supports filters and fetchAll and emits JSON', async () => {
    const child = spawn(process.execPath, ['scripts/market-order-list.js', '--searchType=5',
      '--searchValue', 'demo@example.invalid', '--fetchAll', '--pageSize', '2', '--token', 'test-token'], {
      cwd: path.resolve(__dirname, '..'), env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.deepEqual(result.list, rows);
    assert.equal(result.complete, true);
    assert.equal(result.source.query.search_type, '5');
    assert.equal(result.source.query.search_value, 'demo@example.invalid');
  });
});
