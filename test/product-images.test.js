const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveImageUrl, withErpContext } = require('../scripts/shared.js');

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
      const [ranking] = await api.salesVolumeRanking({ startDate: '2026-01-01', endDate: '2026-01-02', raw: true });
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
