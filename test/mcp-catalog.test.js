const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { commands } = require('../scripts/new-erp.js');
const { listOperations, describeOperation, getOperation } = require('../scripts/mcp-catalog.js');

const hidden = new Set(['username', 'password', 'token', 'output']);
const business = Object.entries(commands).filter(([, command]) => command.kind !== 'local');
const operationName = (name) => name === 'options' ? 'erp_options' : name.replaceAll('-', '_');

test('the catalog exactly covers classified business CLI commands and public API capabilities', async () => {
  for (const command of Object.values(commands)) assert.ok(['read', 'export', 'stream', 'local'].includes(command.kind));
  assert.equal(business.length, 22);
  const expected = [...business.map(([name]) => operationName(name)), 'export_game_products', 'export_outer_packages'].sort();
  assert.deepEqual(listOperations().map(({ name }) => name).sort(), expected);
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

test('all CLI schemas preserve every authoritative argument primitive, default and omission', () => {
  for (const [name, command] of business) {
    const operation = getOperation(operationName(name));
    const args = require(path.join('../scripts', command.script)).args.filter((arg) => !hidden.has(arg.name));
    const expected = Object.fromEntries(args.filter((arg) => arg.default !== undefined).map((arg) => [arg.name, arg.default]));
    assert.deepEqual(operation.schema.parse({}), expected, name);
    assert.deepEqual(Object.keys(operation.schema.shape).sort(), args.map((arg) => arg.name).sort(), name);
    const described = describeOperation(operation.name);
    assert.equal(described.execution, 'job');
    assert.equal(described.effect, command.kind);
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
      if (parent?.filename.endsWith('/mcp-catalog.js') && request.startsWith('./') && request !== './new-erp.js') throw Error('business loaded at startup');
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
    assert.equal(catalog.listOperations().length, 24);
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

test('every CLI adapter invokes its existing callable and only exports receive private hooks', async (t) => {
  const onProgress = () => {};
  const hooks = { outputPath: '/private/job/output', onProgress };
  for (const [name, command] of business) {
    const operation = getOperation(operationName(name));
    const module = require(path.join('../scripts', command.script));
    const expected = operation.schema.parse({});
    if (command.kind === 'export') {
      assert.throws(() => operation.invoke({}), /outputPath/);
      expected.output = hooks.outputPath;
      if (name === 'packing-detail-export') expected.onProgress = onProgress;
    }
    const result = command.kind === 'stream' ? (async function* () { yield { list: [1] }; })() : { original: name };
    const mock = t.mock.method(module, command.kind === 'stream' ? 'pages' : 'main', (options) => {
      assert.deepEqual(options, expected, name);
      return result;
    });
    assert.equal(operation.invoke({}, hooks), result, name);
    assert.equal(mock.mock.callCount(), 1);
    if (command.kind === 'stream') {
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
