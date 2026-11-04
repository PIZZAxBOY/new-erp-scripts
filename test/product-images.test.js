const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveImageUrl, withErpContext } = require('../scripts/shared.js');
const { main: productImages } = require('../scripts/product-images.js');

function galleryData(query) {
  const type = query.get('deal_type');
  const window = query.get('window_img_type');
  if (type === '2') return { image_list: { stock_version_all: {
    'V1': ['/images/pack-1.jpg'], 'V2': ['/images/pack-2.jpg'],
  } } };
  if (type === '1' && window === '1') return { image_list: {
    all: ['/images/main.jpg', 'https://cdn.invalid/sale.jpg'],
    img_main: '/images/main.jpg', sale_main: 'https://cdn.invalid/sale.jpg',
  } };
  return { image_list: { all: [type === '3' ? '/images/main.jpg' : `/images/${type}-${window}.jpg`] } };
}

test('productImages queries all six read-only groups, preserving versions, flags, raw data and current host', async (t) => {
  const api = await import('../index.mjs');
  assert.equal(api.productImages, productImages);
  const calls = [];
  t.mock.method(global, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.token, url.hostname);
    assert.equal(url.searchParams.get('sku'), 'SKU-A');
    await new Promise((resolve) => setImmediate(resolve));
    calls.push([url.hostname, Object.fromEntries(url.searchParams)]);
    const route = url.searchParams.get('r');
    assert.ok(['/products/game-product-list/get-search-sku', '/products/game-product-list/image-list'].includes(route));
    const data = route.endsWith('get-search-sku') ? [{ id: 8, sku: 'SKU-A-extra' }, { id: 9, sku: 'SKU-A' }]
      : galleryData(url.searchParams);
    return new Response(JSON.stringify({ code: 200, data }));
  });
  await Promise.all(['first.invalid', 'second.invalid'].map((host) => withErpContext({ baseUrl: `https://${host}`, token: host }, async () => {
    const result = await productImages({ sku: ' SKU-A ', raw: true });
    assert.equal(result.sku, 'SKU-A');
    assert.equal(result.complete, true);
    assert.equal(result.groups.length, 6);
    assert.equal(result.imageCount, 8);
    assert.equal(result.uniqueImageCount, 7);
    assert.equal(result.urls.length, 7);
    assert.deepEqual(result.groups[0].images[0], { url: `https://${host}/images/main.jpg`,
      originalUrl: '/images/main.jpg', stockVersion: null, isMain: true, isSalesMain: false });
    assert.equal(result.groups[0].images[1].isSalesMain, true);
    assert.equal(result.groups[0].salesMainImageUrl, 'https://cdn.invalid/sale.jpg');
    assert.deepEqual(result.groups[3].images.map((image) => image.stockVersion), ['V1', 'V2']);
    for (const group of result.groups) {
      assert.equal(group.source.query.sku, 'SKU-A');
      assert.deepEqual(JSON.parse(group.rawJson), galleryData(new URLSearchParams(group.source.query)));
    }
    assert.deepEqual(calls.filter(([name]) => name === host).map(([, query]) => query), [
      { r: '/products/game-product-list/get-search-sku', sku: 'SKU-A' },
      ...[['1', '1'], ['1', '2'], ['1', '3'], ['2', null], ['3', null], ['4', null]].map(([type, window]) => ({
        r: '/products/game-product-list/image-list', sku: 'SKU-A', deal_type: type,
        ...(window ? { window_img_type: window } : {}),
      })),
    ]);
  })));
});

test('productImages distinguishes an empty gallery from unknown SKU and incomplete or invalid responses', async (t) => {
  let search = [{ id: 9, sku: 'SKU-A' }];
  let last = { image_list: { all: [] } };
  let denied = false;
  t.mock.method(global, 'fetch', async (input) => {
    const query = new URL(input).searchParams;
    let data;
    if (query.get('r').endsWith('get-search-sku')) data = search;
    else if (query.get('deal_type') === '4') {
      if (denied) return new Response(JSON.stringify({ code: 403, msg: 'denied' }), { status: 403 });
      data = last;
    } else data = query.get('deal_type') === '2'
      ? { image_list: { stock_version_all: {} } } : { image_list: { all: [] } };
    return new Response(JSON.stringify({ code: 200, data }));
  });
  await withErpContext({ baseUrl: 'https://erp.invalid', token: 'image-test-token' }, async () => {
    const empty = await productImages({ sku: 'SKU-A' });
    assert.equal(empty.complete, true);
    assert.equal(empty.imageCount, 0);
    assert.equal(empty.groups.length, 6);
    assert.deepEqual(empty.urls, []);
    assert.ok(empty.groups.every((group) => group.rawJson === null));
    for (const invalid of [{}, { image_list: {} }, { image_list: { all: null } },
      { image_list: { all: ['/images/ok.jpg', 'javascript:alert(1)'] } }]) {
      last = invalid;
      await assert.rejects(productImages({ sku: 'SKU-A' }), /invalid/);
    }
    denied = true;
    await assert.rejects(productImages({ sku: 'SKU-A' }), /403/);
    search = [{ id: 8, sku: 'SKU-A-extra' }];
    await assert.rejects(productImages({ sku: 'SKU-A' }), /No exact ERP SKU/);
    search = {};
    await assert.rejects(productImages({ sku: 'SKU-A' }), /invalid SKU/);
  });
});

test('productImages validates inputs before authentication or network requests', async (t) => {
  const fetchMock = t.mock.method(global, 'fetch', () => { throw new Error('unexpected request'); });
  for (const options of [{}, { sku: '' }, { sku: ' ' }, { sku: 42 }, { sku: 'SKU-A', raw: 'true' }]) {
    await assert.rejects(productImages(options), /sku|raw/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('image URLs resolve relative paths, preserve full URLs and reject empty or unsafe values', () => {
  withErpContext({ baseUrl: 'https://erp.invalid/app/index.php', token: 'image-test-token' }, () => {
    for (const [input, expected] of [
      ['/images/S/main.jpg', 'https://erp.invalid/images/S/main.jpg'],
      ['images/S/main.jpg', 'https://erp.invalid/app/images/S/main.jpg'],
      ['//cdn.invalid/main.jpg', 'https://cdn.invalid/main.jpg'],
      ['https://cdn.invalid/main.jpg?signature=a%2Fb&x=1', 'https://cdn.invalid/main.jpg?signature=a%2Fb&x=1'],
      ['http://cdn.invalid/main.jpg', 'http://cdn.invalid/main.jpg'],
      [null, null], [undefined, null], ['', null], ['  ', null],
      ['javascript:alert(1)', null], ['data:image/png;base64,AAAA', null],
      ['https://user:secret@cdn.invalid/main.jpg', null], ['https://[invalid', null],
    ]) assert.equal(resolveImageUrl(input), expected);
    assert.equal(resolveImageUrl('', '/images/main.jpg'), 'https://erp.invalid/images/main.jpg');
    assert.equal(resolveImageUrl('https://cdn.invalid/main.jpg', '/images/main.jpg'), 'https://cdn.invalid/main.jpg');
  });
});

test('SKU list, batch, detail and ranking expose full main image URLs without changing raw JSON', async (t) => {
  const api = await import('../index.mjs');
  let product;
  t.mock.method(global, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://erp.invalid');
    const data = url.searchParams.get('r') === '/products/product-basic/detail'
      ? { product_basic_info: product }
      : { page: 1, pageSize: 20, totalCount: 1, list: [product] };
    return new Response(JSON.stringify({ code: 200, data }));
  });
  await withErpContext({ baseUrl: 'https://erp.invalid', token: 'image-test-token' }, async () => {
    for (const [fields, expected] of [
      [{ image_url: '/images/S/main.jpg' }, 'https://erp.invalid/images/S/main.jpg'],
      [{ image_url: '/images/S/main.jpg', full_image_url: 'https://cdn.invalid/main.jpg?x=1' }, 'https://cdn.invalid/main.jpg?x=1'],
      [{ image_url: '/images/S/main.jpg', full_image_url: '' }, 'https://erp.invalid/images/S/main.jpg'],
      [{ image_url: null }, null],
    ]) {
      product = { id: 42, sku: 'SKU-A', sales_sum: 2, mean: 1, ...fields };
      const original = JSON.stringify(product);
      const [list] = await api.gameProductList({ sku: 'SKU-A', raw: true });
      const [batch] = await api.gameProductBatch({ skus: 'SKU-A' });
      const [detail] = await api.productDetail({ id: 42, raw: true });
      const [ranking] = await api.salesVolumeRanking({ source: 'list', startDate: '2026-01-01', endDate: '2026-01-02', raw: true });
      for (const row of [list, batch, detail, ranking]) assert.equal(row.imageUrl, expected);
      assert.equal(list.rawJson, original);
      assert.equal(ranking.rawJson, original);
      assert.deepEqual(JSON.parse(detail.rawJson).product_basic_info, product);
    }
  });
});

test('missing batch SKU has a null image and concurrent ERP contexts use their own image host', async (t) => {
  const { gameProductBatch, gameProductList } = await import('../index.mjs');
  t.mock.method(global, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(options.headers.token, url.hostname);
    await new Promise((resolve) => setImmediate(resolve));
    const list = url.searchParams.get('sku') === 'MISSING' ? [] : [{ id: 42, sku: 'SKU-A', image_url: '/images/main.jpg' }];
    return new Response(JSON.stringify({ code: 200, data: { page: 1, pageSize: 20, totalCount: list.length, list } }));
  });
  await Promise.all(['first.invalid', 'second.invalid'].map((host) => withErpContext({ baseUrl: `https://${host}`, token: host }, async () => {
    const [product] = await gameProductList({ sku: 'SKU-A' });
    assert.equal(product.imageUrl, `https://${host}/images/main.jpg`);
    const [missing] = await gameProductBatch({ skus: 'MISSING' });
    assert.equal(missing.found, false);
    assert.equal(missing.imageUrl, null);
  })));
});
