const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { test } = require('node:test');
const { main: productDetail } = require('../scripts/product-detail.js');

const asin = 'B012345678';
const routes = {
  options: '/sales/ling-xing/jy-amazon-selected-option',
  listings: '/sales/ling-xing/jy-amazon-list-data',
  products: '/products/game-product-list/index',
  discontinuedProducts: '/products/game-product-list/game-disuse-product-list',
  detail: '/products/product-basic/detail',
};

async function config(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-asin-test-'));
  const keys = ['NEW_ERP_BASE_URL', 'NEW_ERP_CONFIG', 'NEW_ERP_TOKEN', 'NEW_ERP_SESSION_FILE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NEW_ERP_BASE_URL = 'https://erp.test.invalid';
  process.env.NEW_ERP_CONFIG = path.join(directory, 'config.json');
  process.env.NEW_ERP_SESSION_FILE = path.join(directory, 'session.json');
  delete process.env.NEW_ERP_TOKEN;
  await fs.writeFile(process.env.NEW_ERP_CONFIG, '{}');
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify({ code: status, data }), { status });
}

function paged(rows, url) {
  const page = Number(url.searchParams.get('page'));
  const pageSize = Number(url.searchParams.get('pageSize'));
  return json({ page, pageSize, totalCount: rows.length, list: rows.slice((page - 1) * pageSize, page * pageSize) });
}

test('product detail resolves ASIN through authenticated ERP listings and keeps store matches', async (t) => {
  await config(t);
  const calls = [];
  const listings = [
    { id: 1, asin, sku: 'SKU-A', seller_sku: 'SELLER-A', domain_arr: { sid: 'STORE-1' } },
    { id: 2, asin, sku: 'SKU-A', seller_sku: 'SELLER-B', domain_arr: { sid: 'STORE-2' } },
    { id: 3, asin: `${asin}X`, sku: 'DO-NOT-USE' },
  ];
  t.mock.method(global, 'fetch', async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://erp.test.invalid');
    assert.equal(options.headers.token, 'own-token');
    const route = url.searchParams.get('r');
    calls.push(route);
    if (route === routes.options) return json({ other_select_name1_arr: { sku: 'ERPSKU', '7': 'ASIN' } });
    if (route === routes.listings) {
      assert.equal(url.searchParams.get('other_select_name1'), '7');
      assert.equal(url.searchParams.get('other_select_value1'), asin);
      assert.equal(url.searchParams.has('auction_site'), false);
      return paged(listings, url);
    }
    if (route === routes.products) {
      assert.equal(url.searchParams.get('sku'), 'SKU-A');
      return paged([{ id: 41, sku: 'SKU-AB' }, { id: 42, sku: 'SKU-A' }], url);
    }
    assert.equal(route, routes.detail);
    assert.equal(url.searchParams.get('id'), '42');
    return json({ product_basic_info: { id: 42, sku: 'SKU-A', image_url: '/images/P/SKU-A/main.jpg' } });
  });
  const rows = await productDetail({ asin: ` ${asin.toLowerCase()} `, token: 'own-token' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 42);
  assert.equal(rows[0].sku, 'SKU-A');
  assert.equal(rows[0].asin, asin);
  assert.equal(rows[0].imageUrl, '/images/P/SKU-A/main.jpg');
  assert.deepEqual(rows[0].asinListings, listings.slice(0, 2));
  assert.equal(rows[0].asinSource.route, routes.listings);
  assert.equal(rows[0].asinSource.complete, true);
  assert.deepEqual(calls, [routes.options, routes.listings, routes.products, routes.detail]);
});

test('ASIN searches page through listings and SKU prefix matches and retain multiple products', async (t) => {
  await config(t);
  const listings = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, asin, sku: index === 100 ? 'SKU-B' : 'SKU-A' }));
  const productsA = [...Array.from({ length: 100 }, (_, index) => ({ id: index + 1000, sku: `SKU-A-${index}` })), { id: 42, sku: 'SKU-A' }];
  const detailIds = [];
  t.mock.method(global, 'fetch', async (value) => {
    const url = new URL(value);
    const route = url.searchParams.get('r');
    if (route === routes.options) return json({ other_select_name1_arr: { asin: 'ASIN' } });
    if (route === routes.listings) return paged(listings, url);
    if (route === routes.products) return paged(url.searchParams.get('sku') === 'SKU-A' ? productsA : [{ id: 43, sku: 'SKU-B' }], url);
    const id = Number(url.searchParams.get('id'));
    detailIds.push(id);
    return json({ product_basic_info: { id, sku: id === 42 ? 'SKU-A' : 'SKU-B' } });
  });
  const rows = await productDetail({ asin, token: 'own-token' });
  assert.deepEqual(rows.map((row) => row.sku), ['SKU-A', 'SKU-B']);
  assert.equal(rows[0].asinListings.length, 100);
  assert.equal(rows[1].asinListings.length, 1);
  assert.deepEqual(detailIds, [42, 43]);
  await assert.rejects(productDetail({ asin, token: 'own-token', maxPages: 1 }), /exceeding maxPages/);
});

test('ASIN product detail includes discontinued products and their images', async (t) => {
  await config(t);
  t.mock.method(global, 'fetch', async (value, options) => {
    const url = new URL(value);
    assert.equal(options.headers.token, 'own-token');
    const route = url.searchParams.get('r');
    if (route === routes.options) return json({ other_select_name1_arr: { asin: 'ASIN' } });
    if (route === routes.listings) return paged([{ id: 1, asin, sku: 'SKU-OLD' }], url);
    if (route === routes.products) return paged([], url);
    if (route === routes.discontinuedProducts) return paged([{ id: 42, sku: 'SKU-OLD' }], url);
    assert.equal(route, routes.detail);
    assert.equal(url.searchParams.get('id'), '42');
    return json({ product_basic_info: { id: 42, sku: 'SKU-OLD', image_url: '/images/old.jpg' } });
  });
  const rows = await productDetail({ asin, token: 'own-token' });
  assert.equal(rows[0].sku, 'SKU-OLD');
  assert.equal(rows[0].imageUrl, '/images/old.jpg');
});

test('invalid selectors fail before authentication or any network access', async (t) => {
  await config(t);
  const mock = t.mock.method(global, 'fetch', async () => { throw new Error('unexpected request'); });
  for (const options of [{}, { id: 42, asin }, { asin: '' }, { asin: 'invalid' }, { asin: null },
    { id: -1 }, { asin, maxPages: 0 }]) {
    await assert.rejects(productDetail(options), /id|asin|maxPages/);
  }
  assert.equal(mock.mock.callCount(), 0);
});

test('missing mappings, denied permissions and wrong product details never fall back to public pages', async (t) => {
  await config(t);
  let mode;
  const calls = [];
  t.mock.method(global, 'fetch', async (value) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://erp.test.invalid');
    const route = url.searchParams.get('r'); calls.push(route);
    if (mode === 'denied') return new Response('{"code":403,"msg":"permission denied"}', { status: 403 });
    if (route === routes.options) return json({ other_select_name1_arr: mode === 'no-option' ? { sku: 'SKU' } : { asin: 'ASIN' } });
    if (route === routes.listings) {
      const rows = mode === 'empty' ? [] : [{ id: 1, asin, sku: mode === 'unpaired' ? '' : 'SKU-A' }];
      if (mode === 'no-asin') delete rows[0].asin;
      return paged(rows, url);
    }
    if (route === routes.products || route === routes.discontinuedProducts) return paged(mode === 'no-sku' ? [] : [{ id: 42, sku: 'SKU-A' }], url);
    return json({ product_basic_info: { id: 42, sku: 'WRONG-SKU' } });
  });
  for (const [value, expected] of [['no-option', /ASIN.*search|ASIN.*搜索/], ['empty', /No.*ASIN|未找到/],
    ['unpaired', /SKU/], ['no-asin', /ASIN/], ['no-sku', /SKU/], ['wrong-detail', /SKU/], ['denied', /403/]]) {
    mode = value;
    await assert.rejects(productDetail({ asin, token: 'own-token' }), expected);
  }
  assert.ok(calls.length > 0);
});

test('ASIN CLI uses the ERP search flow and prints product information', async (t) => {
  await config(t);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const route = url.searchParams.get('r');
    assert.equal(request.headers.token, 'cli-own-token');
    let data;
    if (route === routes.options) data = { other_select_name1_arr: { asin: 'ASIN' } };
    else if (route === routes.detail) data = { product_basic_info: { id: 42, sku: 'SKU-A', image_url: '/images/example.jpg' } };
    else data = { page: 1, pageSize: 100, totalCount: 1, list: route === routes.listings ? [{ id: 1, asin, sku: 'SKU-A' }] : [{ id: 42, sku: 'SKU-A' }] };
    response.end(JSON.stringify({ code: 200, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const child = spawn(process.execPath, [path.join(__dirname, '../scripts/new-erp.js'), 'product-detail', '--asin', asin],
    { env: { ...process.env, NEW_ERP_BASE_URL: `http://127.0.0.1:${server.address().port}`, NEW_ERP_TOKEN: 'cli-own-token' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(status, 0, stderr);
  assert.equal(JSON.parse(stdout)[0].asin, asin);
  assert.equal(JSON.parse(stdout)[0].imageUrl, '/images/example.jpg');
});
