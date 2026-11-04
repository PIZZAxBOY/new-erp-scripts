const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { listOperations, describeOperation, getOperation } = require('../scripts/mcp-catalog.js');

const hidden = new Set(['username', 'password', 'token', 'output']);
const business = [
  ['market_order_list', '查询市场订单与订单原始字段', 'read', 'market-order-list.js'],
  ['catalog_list', '查找商品分类与分类 ID', 'read', 'catalog-list.js'],
  ['category_summary', '按分类统计匹配的 SKU 销售记录', 'read', 'category-summary.js'],
  ['game_product_batch', '批量查询多个商品 SKU', 'read', 'game-product-batch.js'],
  ['game_product_list', '按 SKU、名称或分类搜索商品', 'read', 'game-product-list.js'],
  ['product_detail', '按商品 ID 或 ASIN 查询 ERP 商品详情与图片', 'read', 'product-detail.js'],
  ['product_images', '按精确 SKU 查询 ERP 完整图集：橱窗图、小图、包装图、宣传图、样品图', 'read', 'product-images.js'],
  ['sales_volume_ranking', '查询日期范围内的 SKU 销量排名', 'read', 'sales-volume-ranking.js'],
  ['sales_volume_export', '异步导出销量 CSV', 'export', 'sales-volume-export.js'],
  ['supply_evidence', '查询计划、库存及货物流转凭证', 'read', 'supply-evidence.js'],
  ['stocking_assembly_inbound', '统计备货拼装的实际入库数量', 'read', 'stocking-assembly-inbound.js'],
  ['packing_order_list', '查询装箱单列表', 'read', 'packing-order-list.js'],
  ['packing_order_pages', '逐页读取装箱记录并输出 NDJSON', 'stream', 'packing-order-list.js', 'pages'],
  ['packing_detail', '查询单箱明细', 'read', 'packing-detail.js'],
  ['plan_delivery_order_list', '查询历史配货明细', 'read', 'plan-delivery-order-list.js'],
  ['packing_detail_export', '导出装箱明细 XLSX', 'export', 'packing-detail-export.js'],
  ['packing_batch_list', '查询配货批次', 'read', 'packing-batch-list.js'],
  ['packing_batch_detail', '查询配货批次的 SKU 与 BOM 明细', 'read', 'packing-batch-detail.js'],
  ['outer_package_list', '查询外包装规格与版本', 'read', 'outer-package-list.js'],
  ['inventory_list', '查询库存批次或仓库汇总', 'read', 'inventory-list.js'],
  ['logistics_channel_list', '查询物流渠道与运输方式', 'read', 'logistics-channel-list.js'],
  ['product_declaration_list', '查询商品申报主数据', 'read', 'product-declaration-list.js'],
  ['erp_options', '读取实时仓库、状态等枚举', 'read', 'erp-options.js'],
];
const apiOperations = [
  ['export_game_products', '导出在用或停用商品 XLSX', 'export'],
  ['export_outer_packages', '导出外包装规格 XLSX', 'export'],
];

test('the independent MCP registry preserves all business metadata and public API parity', async () => {
  const metadata = listOperations().map(({ name, description, effect }) => [name, description, effect])
    .sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(metadata, [...business.map(([name, description, effect]) => [name, description, effect]), ...apiOperations]
    .sort(([a], [b]) => a.localeCompare(b)));
  const expected = [...business.map(([name]) => name), ...apiOperations.map(([name]) => name)].sort();
  const api = await import('../index.mjs');
  const callable = Object.entries(api).filter(([name]) => name !== 'erpClient').map(([name]) => name).sort();
  const publicNames = expected.map((name) => ({ erp_options: 'erpOptions', packing_detail_export: 'exportPackingDetails' })[name]
    || name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())).sort();
  assert.deepEqual(callable, publicNames);
  assert.deepEqual(listOperations('product_detail'), listOperations().filter(({ name }) => name === 'product_detail'));
  assert.equal(listOperations('商品').length > 0, true);
  assert.deepEqual(listOperations('export products').map(({ name }) => name), ['export_game_products']);
  assert.equal(listOperations('库存 仓库').some(({ name }) => name === 'inventory_list'), true);
  assert.deepEqual(listOperations('no_such_operation'), []);
  for (const item of listOperations()) assert.deepEqual(Object.keys(item).sort(), ['description', 'effect', 'name']);
  for (const name of ['login', 'logout', 'setup', 'mcp', 'erpClient', 'options', 'constructor', '__proto__']) {
    assert.throws(() => getOperation(name), /Unknown ERP operation/);
    assert.throws(() => describeOperation(name), /Unknown ERP operation/);
  }
});

test('all MCP schemas preserve every business argument primitive, default and omission', () => {
  for (const [name, , effect, script, method] of business) {
    const operation = getOperation(name);
    const args = require(path.join('../scripts', script)).args.filter((arg) => !hidden.has(arg.name)
      && !(name === 'packing_order_pages' && arg.name === 'fetchAll'));
    const expected = Object.fromEntries(args.filter((arg) => arg.default !== undefined).map((arg) => [arg.name, arg.default]));
    assert.deepEqual(operation.schema.parse({}), expected, name);
    assert.deepEqual(Object.keys(operation.schema.shape).sort(), args.map((arg) => arg.name).sort(), name);
    const described = describeOperation(operation.name);
    assert.equal(described.execution, 'job');
    assert.equal(described.effect, effect);
    assert.equal(described.inputSchema.additionalProperties, false);
    for (const arg of args) {
      const value = { string: 'valid-alias', int: 7, bool: true }[arg.type];
      assert.equal(operation.schema.parse({ [arg.name]: value })[arg.name], value, `${name}.${arg.name}`);
      for (const wrong of [null, [], {}, ...({ string: [7, true], int: ['7', true, 1.5], bool: ['true', 1] }[arg.type])]) {
        assert.equal(operation.schema.safeParse({ [arg.name]: wrong }).success, false, `${name}.${arg.name} rejects ${JSON.stringify(wrong)}`);
      }
      assert.equal(described.inputSchema.properties[arg.name].description, arg.help);
      if (arg.default !== undefined) assert.deepEqual(described.inputSchema.properties[arg.name].default, arg.default);
      if (arg.choices) assert.ok(described.requirements.some((line) => line.includes(arg.choices.join(', '))));
    }
  }
  for (const name of ['packing_order_list', 'packing_order_pages']) {
    const options = getOperation(name).schema.parse({ packingNo: 'PACK-1' });
    for (const field of ['project', 'warehouses', 'startDate', 'endDate']) assert.equal(Object.hasOwn(options, field), false);
  }
  const pages = getOperation('packing_order_pages').schema;
  assert.equal(Object.hasOwn(pages.parse({}), 'fetchAll'), false);
  assert.equal(pages.safeParse({ fetchAll: true }).success, false);
});

test('all operation boundaries exclude credentials, output, hooks and arbitrary parameters', () => {
  for (const { name } of listOperations()) {
    const operation = getOperation(name);
    const valid = name === 'export_outer_packages' ? { flowStatus: '1' } : {};
    for (const field of [...hidden, 'baseUrl', 'url', 'route', 'onProgress', 'outputPath', 'unexpected']) {
      assert.equal(operation.schema.safeParse({ ...valid, [field]: 'injected' }).success, false, `${name}.${field}`);
      assert.throws(() => operation.invoke({ ...valid, [field]: 'injected' }));
      assert.equal(Object.hasOwn(describeOperation(name).inputSchema.properties, field), false);
    }
  }
});

test('API-only schemas permit arbitrary unique ERP field names and all known outer flow codes', () => {
  const products = getOperation('export_game_products').schema;
  assert.deepEqual(products.parse({}), { fields: ['sku', 'name_cn', 'price'], disused: false });
  assert.deepEqual(products.parse({ fields: ['custom_erp_field'] }).fields, ['custom_erp_field']);
  for (const fields of [[], [''], ['  '], ['sku', 'sku'], [1], 'sku']) assert.equal(products.safeParse({ fields }).success, false);
  const outer = getOperation('export_outer_packages').schema;
  for (const flowStatus of ['1', '2', '3', '4', '5', 1, 2, 3, 4, 5]) assert.equal(outer.safeParse({ flowStatus }).success, true);
  for (const flowStatus of ['', '0', '6', 0, 6, 1.5, null, true]) assert.equal(outer.safeParse({ flowStatus }).success, false);
  assert.equal(outer.safeParse({}).success, false);
});

test('startup and listing load no business code and perform no config/session/network/output work', () => {
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function (request, parent, ...rest) {
      if (parent?.filename.endsWith('/mcp-catalog.js') && request.startsWith('./')) throw Error('business loaded at startup');
      return original.call(this, request, parent, ...rest);
    };
    const fs = require('node:fs');
    const read = fs.readFileSync;
    fs.readFileSync = function (name, ...rest) {
      if (String(name).includes('catalog-no-read')) throw Error('config/session read');
      return read.call(this, name, ...rest);
    };
    fs.writeFileSync = fs.mkdirSync = () => { throw Error('unexpected disk mutation'); };
    global.fetch = () => { throw Error('unexpected network'); };
    require('node:child_process').spawnSync = () => { throw Error('unexpected process'); };
    const catalog = require('./scripts/mcp-catalog.js');
    assert.equal(catalog.listOperations().length, 25);
    assert.equal(catalog.listOperations('inventory').length, 1);
    assert.equal(require.cache[require.resolve('./scripts/shared.js')], undefined);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, NEW_ERP_CONFIG: '/catalog-no-read/config.json', NEW_ERP_SESSION_FILE: '/catalog-no-read/session.json' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, '');
});

test('describing one operation loads only selected metadata and never business execution', () => {
  const script = `
    const assert = require('node:assert/strict');
    const catalog = require('./scripts/mcp-catalog.js');
    const fs = require('node:fs');
    const read = fs.readFileSync;
    fs.readFileSync = function (name, ...rest) {
      if (String(name).includes('catalog-no-read')) throw Error('config/session read');
      return read.call(this, name, ...rest);
    };
    global.fetch = () => { throw Error('business invoked'); };
    const description = catalog.describeOperation('product_declaration_list');
    assert.ok(description.inputSchema.properties.sku);
    assert.ok(require.cache[require.resolve('./scripts/product-declaration-list.js')]);
    for (const filename of ['game-product-list.js', 'packing-order-list.js', 'sales-volume-ranking.js']) {
      assert.equal(require.cache[require.resolve('./scripts/' + filename)], undefined);
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, NEW_ERP_CONFIG: '/catalog-no-read/config.json', NEW_ERP_SESSION_FILE: '/catalog-no-read/session.json' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, '');
});

test('every MCP adapter invokes its existing callable and only exports receive private hooks', async (t) => {
  const onProgress = () => {};
  const hooks = { outputPath: '/private/job/output', onProgress };
  for (const [name, , effect, script, method] of business) {
    const operation = getOperation(name);
    const module = require(path.join('../scripts', script));
    const expected = operation.schema.parse({});
    if (effect === 'export') {
      assert.throws(() => operation.invoke({}), /outputPath/);
      expected.output = hooks.outputPath;
      if (name === 'packing_detail_export') expected.onProgress = onProgress;
    }
    const result = effect === 'stream' ? (async function* () { yield { list: [1] }; })() : { original: name };
    const mock = t.mock.method(module, method || (effect === 'stream' ? 'pages' : 'main'), (options) => {
      assert.deepEqual(options, expected, name);
      return result;
    });
    assert.equal(operation.invoke({}, hooks), result, name);
    assert.equal(mock.mock.callCount(), 1);
    if (effect === 'stream') {
      const pages = [];
      for await (const page of result) pages.push(page);
      assert.deepEqual(pages, [{ list: [1] }]);
    }
    mock.mock.restore();
  }
});

test('API export adapters call actual public exports with their intended ERP routes and fields', async (t) => {
  const shared = require('../scripts/shared.js');
  t.mock.method(shared, 'resolveToken', async () => 'fixture-token');
  t.mock.method(shared, 'getBaseUrl', () => 'https://fixture.invalid');
  let submitted;
  const submissions = [];
  t.mock.method(shared, 'requestJson', async (value, options) => {
    const url = new URL(value);
    const route = url.searchParams.get('r');
    if (route === '/settings/download-center/index') {
      return { data: { list: submitted ? [{ id: 10, status: '3', route_url: submitted.route.slice(1),
        field_selects: JSON.stringify({ basic: submitted.fields }),
        add_condition: JSON.stringify({ flow_status: submitted.flowStatus }) }] : [] } };
    }
    const fields = options.body ? [...options.body.entries()].filter(([key]) => key.startsWith('request_data[export_filed]')).map(([, value]) => value) : undefined;
    submitted = { route, fields, flowStatus: url.searchParams.get('flow_status') };
    submissions.push(submitted);
    return { data: {} };
  });
  t.mock.method(global, 'fetch', async (value, options) => {
    assert.equal(new URL(value).searchParams.get('r'), '/settings/download-center/download-file');
    assert.equal(options.headers.token, 'fixture-token');
    return new Response(Buffer.from('PK-fixture'), { headers: { 'content-disposition': 'attachment; filename=export.xlsx' } });
  });
  for (const disused of [false, true]) {
    submitted = undefined;
    const result = await getOperation('export_game_products').invoke({ fields: ['custom_erp_field'], disused });
    assert.equal(result.taskId, '10');
    assert.ok(Buffer.isBuffer(result.file));
    assert.equal(submitted.route, disused ? '/products/game-product-list/disuse-product-export' : '/products/game-product-list/product-export');
    assert.deepEqual(submitted.fields, ['custom_erp_field']);
  }
  submitted = undefined;
  const result = await getOperation('export_outer_packages').invoke({ flowStatus: 2 });
  assert.ok(Buffer.isBuffer(result.file));
  assert.equal(submitted.route, '/products/outer-package-product/export');
  assert.equal(submitted.flowStatus, '2');
  assert.equal(submissions.length, 3);
});
