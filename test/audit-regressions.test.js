const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const shared = require('../scripts/shared.js');
const { matchingTask } = require('../scripts/sales-volume-export.js');
const { summarize } = require('../scripts/stocking-assembly-inbound.js');

function setEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function startServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function json(data) {
  return new Response(JSON.stringify({ code: 200, data }));
}

test('authenticated JSON requests refuse redirects without forwarding the token', async (t) => {
  let leakedRequests = 0;
  const destination = await startServer(t, (request, response) => {
    leakedRequests++;
    response.end('{"code":200}');
  });
  const baseUrl = await startServer(t, (request, response) => {
    response.writeHead(302, { Location: `${destination}/capture` });
    response.end();
  });
  setEnv(t, { NEW_ERP_BASE_URL: baseUrl });
  await assert.rejects(shared.requestJson(`${baseUrl}/index.php`, {
    headers: { token: 'fake-audit-token' },
  }), /failed/);
  assert.equal(leakedRequests, 0);
});

test('JSON timeouts cover both response headers and a streaming response body', { timeout: 3000 }, async (t) => {
  const baseUrl = await startServer(t, (request, response) => {
    if (request.url === '/headers') return;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
    const timer = setInterval(() => response.write(' '), 10);
    response.on('close', () => clearInterval(timer));
  });
  setEnv(t, { NEW_ERP_BASE_URL: baseUrl });
  for (const route of ['/headers', '/body']) {
    await assert.rejects(shared.requestJson(`${baseUrl}${route}`, { timeoutMs: 80 }), /failed/);
  }
});

test('empty CLI results show the reason and exit with an integer code', () => {
  const result = spawnSync(process.execPath, ['scripts/game-product-batch.js', '--skus', ',,,'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No SKU input/);
  assert.doesNotMatch(result.stderr, /TypeError|ERR_INVALID_ARG_TYPE|\n\s+at /);
});

test('both product searches expand a live parent category once per call', async (t) => {
  const api = await import('../index.mjs');
  setEnv(t, { NEW_ERP_BASE_URL: 'https://audit.invalid' });
  const routes = [];
  t.mock.method(global, 'fetch', async (input) => {
    const url = new URL(input);
    const route = url.searchParams.get('r');
    routes.push(route);
    if (route.endsWith('selected-options')) return json({ catalog_list: [{ id: 10, name_cn: '父类',
      son: [{ id: 11, parent: 10, name_cn: '子类' }] }] });
    assert.equal(url.searchParams.get('catalog_id'), '10,11');
    return json({ totalCount: 1, list: [{ id: 1, sku: url.searchParams.get('sku') || 'ABC' }] });
  });
  const list = await api.gameProductList({ catalogId: '10', token: 'fake-token' });
  const batch = await api.gameProductBatch({ catalogId: '10', skus: 'ABC,DEF', token: 'fake-token' });
  assert.equal(list[0].sku, 'ABC');
  assert.deepEqual(batch.map((row) => [row.sku, row.found]), [['ABC', true], ['DEF', true]]);
  assert.equal(routes.filter((route) => route.endsWith('selected-options')).length, 2);
});

test('sales task reuse excludes extra nonempty filters and accepts exact conditions', () => {
  const start = '2026-01-01 00:00:00', end = '2026-01-31 23:59:59';
  const query = { mode: 'domain', aggregate_by: 'platform', date_dimension: 'monthly',
    date_range: `${start} & ${end}`, index: 'sales-volume' };
  const task = (params) => ({ id: 1, start_date: start, end_date: end,
    add_condition: JSON.stringify({ params }) });
  for (const filter of ['auction_site_type', 'auction_site', 'catalog_id', 'sku', 'product_type_cate']) {
    assert.equal(matchingTask([task({ ...query, [filter]: 'restricted' })], query, start, end), undefined);
  }
  assert.equal(matchingTask([task(query)], query, start, end).id, 1);
  assert.equal(matchingTask([task({ ...query, sku: '', auction_site: null })], query, start, end).id, 1);
  const amazon = { ...query, auction_site_type: 'Amazon' };
  assert.equal(matchingTask([task(query)], amazon, start, end), undefined);
  assert.equal(matchingTask([task(amazon)], amazon, start, end).id, 1);
});

test('full list and evidence reads reject short pages, repeated IDs and changed totals', async (t) => {
  const api = await import('../index.mjs');
  setEnv(t, { NEW_ERP_BASE_URL: 'https://audit.invalid' });
  let mode = 'complete';
  t.mock.method(global, 'fetch', async (input) => {
    const url = new URL(input);
    const page = Number(url.searchParams.get('page'));
    const rows = [{ id: 1, sku: 'ABC' }, { id: 2, sku: 'ABCD' }, { id: 3, sku: 'ABC' }];
    let list = rows.slice((page - 1) * 2, page * 2);
    if (mode === 'short') list = list.slice(0, 1);
    if (mode === 'duplicate' && page === 2) list = [{ id: '2', sku: 'ABC' }];
    return json({ page, pageSize: 2, totalCount: mode === 'null-total' ? null
      : mode === 'changed-total' && page === 2 ? 4 : 3, list });
  });
  const options = { token: 'fake-token', pageSize: 2, fetchAll: true };
  const channels = await api.logisticsChannelList(options);
  assert.equal(channels.complete, true);
  const evidence = await api.supplyEvidence({ ...options, source: 'inventory', sku: 'ABC' });
  assert.deepEqual(evidence.map((row) => row.id), [1, 3]);
  for (mode of ['short', 'duplicate', 'null-total', 'changed-total']) {
    await assert.rejects(api.logisticsChannelList(options), /pagination|duplicate|totalCount/);
    await assert.rejects(api.supplyEvidence({ ...options, source: 'inventory', sku: 'ABC' }), /pagination|duplicate|totalCount/);
  }
});

test('distinct inventory batches and packaging versions survive repeated product IDs', async (t) => {
  const api = await import('../index.mjs');
  setEnv(t, { NEW_ERP_BASE_URL: 'https://audit.invalid' });
  let duplicate = false;
  t.mock.method(global, 'fetch', async (input) => {
    const url = new URL(input), page = Number(url.searchParams.get('page'));
    return json({ page, pageSize: 1, totalCount: 2, list: [{ id: 1, sku: 'ABC', stock_code: 'DEMO-STOCK',
      advice_id: duplicate ? 'batch1' : `batch${page}`, pack_version: duplicate ? '1' : String(page) }] });
  });
  const options = { token: 'fake-token', pageSize: 1, fetchAll: true, sku: 'ABC' };
  for (const [name, extra] of [['inventoryList', { stockCode: 'DEMO-STOCK' }], ['outerPackageList', { flowStatus: 2 }]]) {
    assert.equal((await api[name]({ ...options, ...extra })).list.length, 2);
    duplicate = true;
    await assert.rejects(api[name]({ ...options, ...extra }), /duplicate/);
    duplicate = false;
  }
});

test('inbound totals reject missing quantities and duplicate receipts but retain zero', () => {
  const row = { id: 1, sku: 'ABC', action_name: '入库', in_out_remark: '拼装物料组合SKU:ABC',
    purchase_orderid: 'PZ1', put_num: '7' };
  const tasks = [{ id: 10, sku: 'ABC', pz_no: 'PZ1', type: '2' }];
  for (const put_num of [null, undefined, '', ' ', 'invalid', -1]) {
    assert.throws(() => summarize('ABC', [{ ...row, put_num }], tasks), /invalid put_num/);
  }
  assert.throws(() => summarize('ABC', [row, { ...row, id: '1', put_num: '9' }], tasks), /duplicate/);
  assert.equal(summarize('ABC', [{ ...row, put_num: '0' }], tasks).quantity, 0);
  assert.equal(summarize('ABC', [row], tasks).quantity, 7);
});

test('inbound pagination rejects overlapping receipts before summing them', async (t) => {
  const api = await import('../index.mjs');
  setEnv(t, { NEW_ERP_BASE_URL: 'https://audit.invalid' });
  t.mock.method(global, 'fetch', async (input) => {
    const url = new URL(input), page = Number(url.searchParams.get('page'));
    assert.equal(url.searchParams.get('r'), '/warehouse/inventory/product-in-out-record');
    const row = (id) => ({ id, sku: 'ABC', action_name: '入库',
      in_out_remark: '拼装物料组合SKU:ABC', purchase_orderid: 'PZ1', put_num: '7' });
    return json({ page, pageSize: 100, totalCount: 101,
      list: page === 1 ? Array.from({ length: 100 }, (_, i) => row(i + 1)) : [row(100)] });
  });
  await assert.rejects(api.stockingAssemblyInbound({ token: 'fake-token', sku: 'ABC',
    startDate: '2026-01-01', endDate: '2026-01-31' }), /duplicate/);
});

test('sales pagination rejects overlapping SKU rows and keeps separate platforms', async (t) => {
  const api = await import('../index.mjs');
  setEnv(t, { NEW_ERP_BASE_URL: 'https://audit.invalid' });
  t.mock.method(global, 'fetch', async (input) => {
    const url = new URL(input), page = Number(url.searchParams.get('page'));
    return json({ totalCount: 2, list: [{ sku: 'ABC', auction_site: 'JY',
      auction_site_type: page === 1 ? 'Amazon' : 'Shopify', sales_sum: page }] });
  });
  const options = { token: 'fake-token', startDate: '2026-01-01', endDate: '2026-01-31',
    pageSize: 1, fetchAll: true };
  await assert.rejects(api.salesVolumeRanking(options), /duplicate/);
  const platforms = await api.salesVolumeRanking({ ...options, aggregateBy: 'sku-platform' });
  assert.deepEqual(platforms.map((row) => row.auctionSiteType), ['Shopify', 'Amazon']);
});

test('category summary counts all pages and rejects duplicated SKU rows', async (t) => {
  const api = await import('../index.mjs');
  setEnv(t, { NEW_ERP_BASE_URL: 'https://audit.invalid' });
  let duplicate = false;
  const pages = [];
  t.mock.method(global, 'fetch', async (input) => {
    const page = Number(new URL(input).searchParams.get('page'));
    pages.push(page);
    const rows = [{ sku: 'ABC', auction_site: 'JY', catalog_name_cn: 'A' },
      { sku: 'DEF', auction_site: 'JY', catalog_name_cn: 'B' },
      { sku: duplicate ? 'ABC' : 'GHI', auction_site: 'JY', catalog_name_cn: 'A' }];
    return json({ totalCount: 3, list: [rows[page - 1]] });
  });
  const options = { token: 'fake-token', startDate: '2026-01-01', endDate: '2026-01-31',
    pageSize: 1, concurrency: 2 };
  const result = await api.categorySummary(options);
  assert.deepEqual(result.map((row) => [row.categoryNameCn, row.skuSalesRowCount]), [['A', 2], ['B', 1]]);
  assert.equal(result[0].fetchedSkuSalesRowCount, 3);
  assert.equal(result[0].fetchedPageCount, 3);
  assert.deepEqual(pages, [1, 2, 3]);
  duplicate = true;
  await assert.rejects(api.categorySummary(options), /duplicate SKU/);
});

test('product and packaging exports use configured tokens, reject ambiguity and pin task IDs', async (t) => {
  const api = await import('../index.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-auth-regression-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'config.json');
  await fs.writeFile(config, JSON.stringify({ token: 'config-token' }));
  setEnv(t, { NEW_ERP_BASE_URL: 'https://audit.invalid', NEW_ERP_CONFIG: config,
    NEW_ERP_TOKEN: '', NEW_ERP_USERNAME: '', NEW_ERP_PASSWORD: '' });
  const originalTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, delay, ...args) => originalTimeout(callback, delay === 3000 ? 0 : delay, ...args));
  let submitted, mode, route, polls, expectedToken;
  const downloads = [];
  const task = (id, status = '3') => ({ id, status, route_url: route.slice(1),
    field_selects: '{"basic":["sku","name_cn","price"]}', add_condition: '{"flow_status":"2"}' });
  t.mock.method(global, 'fetch', async (input, options) => {
    const url = new URL(input), current = url.searchParams.get('r');
    assert.equal(options.headers.token, expectedToken);
    if (current === route) { submitted = true; return json({}); }
    if (current === '/settings/download-center/index') {
      if (!submitted) return json({ list: [] });
      polls++;
      let list = [task('ours')];
      if (mode === 'ambiguous') list.unshift(task('other'));
      if (mode === 'pin') list = polls === 1 ? [task('ours', '2')] : [task('other'), task('ours')];
      if (mode === 'malformed') list.unshift({ ...task('bad'), field_selects: 'bad-json', add_condition: 'bad-json' });
      if (mode === 'failed') list = [{ ...task('ours', '4'), error_reason: `denied ${expectedToken}` }];
      return json({ list });
    }
    assert.equal(current, '/settings/download-center/download-file');
    downloads.push(url.searchParams.get('id'));
    return new Response('PKsample', { headers: { 'content-disposition': 'attachment' } });
  });
  for (const [name, exportRoute, extra] of [
    ['exportGameProducts', '/products/game-product-list/product-export', {}],
    ['exportOuterPackages', '/products/outer-package-product/export', { flowStatus: 2 }],
  ]) {
    route = exportRoute;
    for (mode of ['complete', 'ambiguous', 'pin', 'malformed']) {
      submitted = false; polls = 0; downloads.length = 0;
      expectedToken = 'config-token';
      if (mode === 'ambiguous') {
        await assert.rejects(api[name](extra), /multiple matching/);
        assert.equal(downloads.length, 0);
      } else {
        assert.equal((await api[name](extra)).taskId, 'ours');
        assert.deepEqual(downloads, ['ours']);
      }
    }
    process.env.NEW_ERP_TOKEN = 'env-token';
    expectedToken = 'env-token'; submitted = false; mode = 'complete';
    await api[name](extra);
    expectedToken = 'explicit-token'; submitted = false;
    await api[name]({ ...extra, token: expectedToken });
    submitted = false; mode = 'failed';
    await assert.rejects(api[name]({ ...extra, token: expectedToken }), (error) => {
      assert.match(error.message, /denied/);
      return !error.message.includes(expectedToken);
    });
    process.env.NEW_ERP_TOKEN = '';
  }
});

test('all export downloads refuse cross-origin redirects', async (t) => {
  const api = await import('../index.mjs');
  let leakedRequests = 0, submitted = false, exportRoute;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-redirect-regression-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = await startServer(t, (request, response) => {
    leakedRequests++;
    response.setHeader('content-disposition', 'attachment');
    response.end('PKleaked');
  });
  const query = { auction_site: 'JY', site_type: 'DEMO-DEST', status: '', time_type: 'out_time',
    scan_date: '2026-01-01 00:00:00 & 2026-01-31 23:59:59' };
  const start = '2026-01-01 00:00:00', end = '2026-01-31 23:59:59';
  const params = { mode: 'sku', aggregate_by: 'sku', date_dimension: 'monthly',
    date_range: `${start} & ${end}`, index: 'sales-volume' };
  const baseUrl = await startServer(t, (request, response) => {
    const route = new URL(request.url, 'http://local').searchParams.get('r');
    if (route === '/settings/download-center/download-file') {
      response.writeHead(302, { Location: `${destination}/capture` });
      return response.end();
    }
    let data;
    if (route === exportRoute) { submitted = true; data = {}; request.resume(); }
    else if (route === '/warehouse/packing-order/list') data = { totalCount: 1, list: [{ id: 1, site_type: 'DEMO-DEST' }] };
    else if (route === '/settings/download-center/index') data = { list: submitted ? [{ id: 1, status: '3',
      route_url: exportRoute.slice(1), field_selects: '{"basic":["sku","name_cn","price"]}',
      add_condition: JSON.stringify(exportRoute.includes('outer-package') ? { flow_status: '2' }
        : exportRoute.includes('packing-order') ? query : { params }), start_date: start, end_date: end }] : [] };
    else { response.statusCode = 404; return response.end('{}'); }
    response.end(JSON.stringify({ code: 200, data }));
  });
  setEnv(t, { NEW_ERP_BASE_URL: baseUrl });
  for (const [name, route, extra] of [
    ['exportGameProducts', '/products/game-product-list/product-export', {}],
    ['exportOuterPackages', '/products/outer-package-product/export', { flowStatus: 2 }],
    ['exportPackingDetails', '/warehouse/packing-order/down-packing-detail',
      { project: 'JY', warehouses: ['DEMO-DEST'], startDate: '2026-01-01', endDate: '2026-01-31' }],
    ['salesVolumeExport', '/statistics/sales-volume/download-list',
      { startDate: '2026-01-01', endDate: '2026-01-31', output: path.join(directory, 'sales.csv') }],
  ]) {
    exportRoute = route; submitted = name === 'salesVolumeExport';
    await assert.rejects(api[name]({ token: 'fake-audit-token', ...extra }));
  }
  assert.equal(leakedRequests, 0);
  await assert.rejects(fs.access(path.join(directory, 'sales.csv')), { code: 'ENOENT' });
});

test('all export polls abort within the remaining deadline instead of waiting a full request timeout', { timeout: 3000 }, async (t) => {
  const api = await import('../index.mjs');
  setEnv(t, { NEW_ERP_BASE_URL: 'https://audit.invalid' });
  let clock = 0, route, calls, sales;
  t.mock.method(Date, 'now', () => clock);
  const originalTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
    assert.ok(delay <= 25, `poll sleep exceeds the remaining deadline: ${delay}`);
    return originalTimeout(callback, 0, ...args);
  });
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const start = '2026-01-01 00:00:00', end = '2026-01-31 23:59:59';
  const params = { mode: 'sku', aggregate_by: 'sku', date_dimension: 'monthly',
    date_range: `${start} & ${end}`, index: 'sales-volume' };
  const packing = { auction_site: 'JY', site_type: 'DEMO-DEST', status: '', time_type: 'out_time',
    scan_date: `${start} & ${end}` };
  t.mock.method(global, 'fetch', async (input, options) => {
    const current = new URL(input).searchParams.get('r');
    if (current === route) return json({});
    if (current === '/warehouse/packing-order/list') return json({ totalCount: 1, list: [{ id: 1, site_type: 'DEMO-DEST' }] });
    assert.equal(current, '/settings/download-center/index');
    calls++;
    if (!sales && calls === 1) return json({ list: [] });
    if (calls === (sales ? 1 : 2)) {
      clock = 20 * 60_000 - 25;
      return json({ list: [{ id: 'ours', status: '2', route_url: route.slice(1),
        start_date: start, end_date: end, field_selects: '{"basic":["sku","name_cn","price"]}',
        add_condition: JSON.stringify(sales ? { params } : route.includes('packing-order') ? packing : { flow_status: '2' }) }] });
    }
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  for (const [name, exportRoute, extra] of [
    ['exportGameProducts', '/products/game-product-list/product-export', {}],
    ['exportOuterPackages', '/products/outer-package-product/export', { flowStatus: 2 }],
    ['exportPackingDetails', '/warehouse/packing-order/down-packing-detail',
      { project: 'JY', warehouses: ['DEMO-DEST'], startDate: '2026-01-01', endDate: '2026-01-31' }],
    ['salesVolumeExport', '/statistics/sales-volume/download-list',
      { startDate: '2026-01-01', endDate: '2026-01-31', output: path.join(os.tmpdir(), `erp-deadline-${process.pid}.csv`) }],
  ]) {
    route = exportRoute; calls = 0; clock = 0; sales = name === 'salesVolumeExport';
    await assert.rejects(api[name]({ token: 'fake-token', ...extra }), /failed/);
    assert.equal(calls, sales ? 2 : 3);
  }
});
