const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');

test('packing data APIs retain versions, quantities and scope; pagination fails closed', async (t) => {
  const api = await import('new-erp-scripts');
  const calls = [];
  let mode = '';
  const versions = [{ pack_version: '1', bom_number: '4', price: '1.4000' },
    { pack_version: '4', bom_number: '5', price: '1.2000' }];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const query = url.searchParams;
    const route = query.get('r');
    calls.push({ route, query, method: request.method, token: request.headers.token });
    if (mode === 'denied') {
      response.statusCode = 403;
      response.end(JSON.stringify({ code: 403, msg: 'no permission' }));
      return;
    }
    let data;
    if (route === '/products/product-basic/detail') {
      data = { product_basic_info: { id: '42', sku: 'SKU-A', father_id: null, pack_weight: null, true_weight: '0' },
        product_attribute_info: { length: '0.00', width: null, warehouse_box_sku_store: [] },
        product_sku_version_list: versions, export_logistics_declaration: { declaration_info: {} } };
    } else if (route === '/warehouse/transfer-order-packing/view-detail') {
      data = { confirmed_no: mode === 'wrong-batch' ? 'OTHER' : query.get('confirmed_no'),
        stock_from: query.get('stock_from'), have_packing_data: false,
        provider: [[{ sku: 'SKU-A', num: '13', can_num: '12', now_num: '1', version_number: '16', bom_number: '7' }]] };
    } else if (route === '/warehouse/transfer-order-packing/get-stock-list') {
      data = { 'DEMO-STOCK': '示例库存仓', 'DEMO-FROM': '示例发货仓' };
    } else if (route.endsWith('options')) {
      data = { stock_code_arr: { 'DEMO-STOCK': 'DEMO-STOCK' }, status_list: { 0: '待出库', 1: '已出库' } };
    } else {
      const row = { id: '1', sku: 'SKU-A', stock_code: mode === 'wrong-stock' ? 'OTHER' : 'DEMO-STOCK',
        stock_from: 'DEMO-FROM', site_type: 'FBA_US', dk_status: mode === 'wrong-status' ? '6' : '5',
        stock_count: { num: '0' }, yg_can_stock_count: { num: '10' },
        country: 'US', hs_price: '', hs_currency: 'USD', pack_version: '1', box_num: '300' };
      const rows = Array.from({ length: 3 }, (_, i) => ({ ...row, id: String(i + 1) }));
      const page = Number(query.get('page'));
      const pageSize = Number(query.get('pageSize'));
      data = { page: mode === 'wrong-page' ? page + 1 : page, pageSize,
      totalCount: mode === 'null-total' ? null : mode === 'empty' ? 0
        : mode === 'changed-total' && page > 1 ? 4 : 3,
      list: mode === 'empty' || mode === 'short-page' ? [] : rows.slice((page - 1) * pageSize, page * pageSize) };
    }
    response.end(JSON.stringify({ code: 200, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NEW_ERP_BASE_URL;
  process.env.NEW_ERP_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const options = { token: 'test-token', pageSize: 2 };
  try {
    await t.test('read-only list mappings and full pagination', async () => {
      const specifications = [
        ['packingBatchList', { stockFrom: 'DEMO-FROM', warehouse: 'FBA_US', batchNo: 'BATCH-1' },
          { stock_from: 'DEMO-FROM', site_type: 'FBA_US', confirmed_no: 'BATCH-1', dk_status: '5' }],
        ['outerPackageList', { flowStatus: 2, sku: 'SKU-A', project: 'JY' },
          { flow_status: '2', makeup_sku: 'SKU-A', auction_site: 'JY' }],
        ['inventoryList', { sku: 'SKU-A', stockCode: 'DEMO-STOCK' },
          { select1_key: '1', select2_key: 'sku', select_value: 'SKU-A', stock_code: 'DEMO-STOCK', warehouse_type: '2' }],
        ['logisticsChannelList', {}, {}],
        ['productDeclarationList', { sku: 'SKU-A', country: 'US' }, { sku: 'SKU-A', country: 'US' }],
      ];
      for (const [name, input, expected] of specifications) {
        const result = await api[name]({ ...options, ...input, fetchAll: true });
        assert.equal(result.list.length, 3);
        assert.equal(result.complete, true);
        assert.equal(result.totalCount, 3);
        assert.equal(result.fetchedCount, 3);
        assert.ok(!JSON.stringify(result.source).includes('test-token'));
        assert.ok(Number.isFinite(Date.parse(result.source.fetchedAt)));
        for (const [key, value] of Object.entries(expected)) assert.equal(result.source.query[key], value);
        assert.equal(result.list[0].hs_price, '');
      }
      assert.ok(calls.every((call) => call.method === 'GET' && call.token === 'test-token'));
      const page = await api.logisticsChannelList(options);
      assert.equal(page.complete, false);
      assert.equal(page.fetchedCount, 2);
      await assert.rejects(api.logisticsChannelList({ ...options, fetchAll: true, maxPages: 1 }), /exceeding/);
      const boxes = await api.outerPackageList({ ...options, flowStatus: 1, sku: 'BOX-A' });
      assert.equal(boxes.source.query.sku, 'BOX-A');
    });
    await t.test('all product versions, missing values and raw batch groups survive', async () => {
      const [product] = await api.productDetail({ id: 42, token: 'test-token' });
      assert.deepEqual(product.skuVersions, versions);
      assert.equal(product.fatherId, null);
      assert.equal(product.packWeight, null);
      assert.equal(product.trueWeight, 0);
      assert.equal(product.productAttributeInfo.length, '0.00');
      assert.equal(product.productAttributeInfo.width, null);
      assert.equal(product.rawJson, null);
      const batch = await api.packingBatchDetail({ ...options, batchNo: 'BATCH-1', stockFrom: 'DEMO-FROM' });
      assert.deepEqual(batch.provider[0][0], { sku: 'SKU-A', num: '13', can_num: '12', now_num: '1', version_number: '16', bom_number: '7' });
      for (const source of ['inventory', 'packing', 'batchWarehouses']) {
        const result = await api.erpOptions({ ...options, source });
        assert.ok(Object.keys(result.data).length);
      }
    });
    await t.test('malformed responses, scope mismatches and denied access are errors', async () => {
      for (const scenario of ['short-page', 'null-total', 'changed-total', 'wrong-page']) {
        mode = scenario;
        await assert.rejects(api.logisticsChannelList({ ...options, fetchAll: true }), /pagination|totalCount/);
      }
      mode = 'wrong-stock';
      await assert.rejects(api.inventoryList({ ...options, sku: 'SKU-A', stockCode: 'DEMO-STOCK' }), /outside/);
      mode = 'wrong-status';
      await assert.rejects(api.packingBatchList({ ...options, stockFrom: 'DEMO-FROM' }), /outside/);
      mode = 'wrong-batch';
      await assert.rejects(api.packingBatchDetail({ ...options, stockFrom: 'DEMO-FROM', batchNo: 'BATCH-1' }), /does not match/);
      mode = 'denied';
      await assert.rejects(api.logisticsChannelList(options), /403/);
      mode = 'empty';
      const empty = await api.logisticsChannelList({ ...options, fetchAll: true });
      assert.deepEqual(empty.list, []);
      assert.equal(empty.complete, true);
      mode = '';
    });
    await t.test('invalid scope fails before any ERP request', async () => {
      const count = calls.length;
      for (const [fn, input] of [
        ['packingBatchList', {}], ['packingBatchDetail', { stockFrom: 'DEMO-FROM' }],
        ['inventoryList', { sku: 'SKU-A' }], ['inventoryList', { sku: 'SKU-A', stockCode: 'DEMO-STOCK', groupBy: 'unknown' }],
        ['outerPackageList', { flowStatus: 6 }], ['erpOptions', { source: 'unknown' }],
        ['logisticsChannelList', { page: 2, fetchAll: true }], ['logisticsChannelList', { fetchAll: 'false' }],
      ]) await assert.rejects(api[fn]({ ...options, ...input }));
      assert.equal(calls.length, count);
    });
  } finally {
    if (previous === undefined) delete process.env.NEW_ERP_BASE_URL;
    else process.env.NEW_ERP_BASE_URL = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
