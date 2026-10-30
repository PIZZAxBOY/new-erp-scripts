const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const scriptsRoot = path.join(root, 'scripts');
const scripts = [
  'market-order-list.js',
  'catalog-list.js',
  'category-summary.js',
  'game-product-batch.js',
  'game-product-list.js',
  'product-detail.js',
  'sales-volume-ranking.js',
  'sales-volume-export.js',
  'supply-evidence.js',
  'stocking-assembly-inbound.js',
  'packing-order-list.js',
  'packing-order-pages.js',
  'packing-detail.js',
  'plan-delivery-order-list.js',
  'packing-detail-export.js',
  'packing-batch-list.js',
  'packing-batch-detail.js',
  'outer-package-list.js',
  'inventory-list.js',
  'logistics-channel-list.js',
  'product-declaration-list.js',
  'erp-options.js',

];

test('package exposes callable functions through ES module imports', async () => {
  const api = await import('new-erp-scripts');
  assert.deepEqual(Object.keys(api).sort(), [
    'marketOrderList',
    'catalogList', 'categorySummary', 'exportGameProducts', 'exportOuterPackages', 'gameProductBatch', 'gameProductList',
    'productDetail', 'salesVolumeExport', 'salesVolumeRanking', 'erpClient',
    'stockingAssemblyInbound', 'supplyEvidence', 'packingOrderList', 'exportPackingDetails',
    'packingOrderPages', 'packingDetail', 'planDeliveryOrderList',
    'packingBatchList', 'packingBatchDetail', 'outerPackageList', 'inventoryList', 'logisticsChannelList', 'productDeclarationList', 'erpOptions',
  ].sort());
  assert.equal(typeof api.erpClient.loginToken, 'function');
  assert.equal(typeof api.erpClient.requestJson, 'function');
  await assert.rejects(api.salesVolumeRanking({ startDate: 'bad', endDate: '2026-01-01' }), /startDate/);
});

test('packed npm package installs one unified command, API and separate skill metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-package-test-'));
  try {
    const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(packed.status, 0, packed.stderr);
    const [tarball] = JSON.parse(packed.stdout);
    assert.ok(tarball.files.every(({ path: filename }) =>
      ['index.mjs', 'package.json', 'README.md'].includes(filename)
      || filename.startsWith('scripts/') || filename.startsWith('skills/') || filename.startsWith('docs/')));
    const installed = spawnSync('npm', ['install', '--offline', '--prefix', directory,
      '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', path.join(directory, tarball.filename)], {
      cwd: directory, encoding: 'utf8',
    });
    assert.equal(installed.status, 0, installed.stderr);
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import * as api from 'new-erp-scripts'; console.log(JSON.stringify(Object.keys(api).sort()))"], {
      cwd: directory, encoding: 'utf8',
    });
    assert.equal(imported.status, 0, imported.stderr);
    assert.deepEqual(JSON.parse(imported.stdout), Object.keys(await import('new-erp-scripts')).sort());
    const packageRoot = path.join(directory, 'node_modules', 'new-erp-scripts');
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.bin), ['new-erp']);
    assert.equal(manifest.bin['new-erp'], 'scripts/new-erp.js');
    assert.equal(scripts.length, 22);
    const cli = path.join(directory, 'node_modules', '.bin', 'new-erp');
    const topHelp = spawnSync(cli, [], { cwd: directory, encoding: 'utf8' });
    assert.equal(topHelp.status, 0, topHelp.stderr || topHelp.error);
    assert.match(topHelp.stdout, /^Usage: new-erp <command> \[options\]/m);
    const topHelpLines = topHelp.stdout.split('\n');
    const commandStart = topHelpLines.indexOf('Commands:') + 1;
    const commandEnd = topHelpLines.indexOf('', commandStart);
    const listedCommands = topHelpLines.slice(commandStart, commandEnd);
    assert.deepEqual(listedCommands.map((line) => line.trim().split(/\s+/)[0]),
      scripts.map(commandForScript));
    assert.ok(listedCommands.every((line) => line.trim().length > line.trim().split(/\s+/)[0].length));
    for (const args of [['--help'], ['-h']]) {
      const result = spawnSync(cli, args, { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.error);
      assert.match(result.stdout, /^Usage: new-erp <command> \[options\]/m);
    }
    for (const script of scripts) {
      const command = commandForScript(script);
      assert.ok(topHelp.stdout.includes(command), command);
      const help = spawnSync(cli, [command, '--help'], {
        cwd: directory, encoding: 'utf8',
      });
      assert.equal(help.status, 0, `${command}: ${help.stderr || help.error}`);
      assert.equal(help.stdout.split('\n')[0], `Usage: new-erp ${command} [options]`);
    }
    const secret = 'DO-NOT-ECHO-CLI-TOKEN-123';
    for (const args of [[secret], [`--token=${secret}`], ['--help', secret]]) {
      const result = spawnSync(cli, args, { cwd: directory, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
      assert.match(result.stderr, /new-erp --help/);
    }
    await fs.access(path.join(packageRoot, 'skills', 'new-erp-scripts', 'SKILL.md'));
    await fs.access(path.join(packageRoot, 'skills', 'new-erp-scripts', 'agents', 'openai.yaml'));
    await fs.access(path.join(packageRoot, 'docs', 'api.md'));
    await assert.rejects(fs.access(path.join(packageRoot, 'skills', 'new-erp-scripts', 'scripts')), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('outer package export submits flow status and downloads the matching task', async () => {
  const { exportOuterPackages } = await import('new-erp-scripts');
  let submitted = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const route = url.searchParams.get('r');
    if (route === '/settings/download-center/index') {
      response.end(JSON.stringify({ code: 200, data: { list: submitted ? [
        { id: 43, route_url: 'products/outer-package-product/export',
          add_condition: '{"flow_status":"2"}', status: '3' },
      ] : [] } }));
    } else if (route === '/products/outer-package-product/export') {
      assert.equal(url.searchParams.get('flow_status'), '2');
      submitted = true;
      response.end(JSON.stringify({ code: 200, data: {} }));
    } else if (route === '/settings/download-center/download-file') {
      response.setHeader('content-disposition', 'attachment; filename=pack.xlsx');
      response.end('PKsample');
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NEW_ERP_BASE_URL;
  process.env.NEW_ERP_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await exportOuterPackages({ token: 'test-token', flowStatus: '2' });
    assert.equal(result.taskId, '43');
    assert.equal(result.file.toString(), 'PKsample');
    await assert.rejects(exportOuterPackages({ token: 'test-token', flowStatus: '9' }), /flowStatus/);
  } finally {
    if (previous === undefined) delete process.env.NEW_ERP_BASE_URL;
    else process.env.NEW_ERP_BASE_URL = previous;
    await new Promise(resolve => server.close(resolve));
  }
});

test('product export submits selected fields and downloads the completed task', async () => {
  const { exportGameProducts } = await import('new-erp-scripts');
  let submitted = false;
  let exportRoute = '/products/game-product-list/product-export';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const route = url.searchParams.get('r');
    if (route === '/settings/download-center/index') {
      response.end(JSON.stringify({ code: 200, data: { list: submitted ? [
        { id: 42, route_url: exportRoute.slice(1),
          field_selects: '{"basic":["sku","price"]}', status: '3' },
      ] : [] } }));
    } else if (route === exportRoute) {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        assert.match(body, /request_data\[export_filed\]\[basic\]\[0\]/);
        assert.match(body, /sku/);
        submitted = true;
        response.end(JSON.stringify({ code: 200, data: {} }));
      });
    } else if (route === '/settings/download-center/download-file') {
      response.setHeader('content-disposition', 'attachment; filename=products.xlsx');
      response.end('PKsample');
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NEW_ERP_BASE_URL;
  process.env.NEW_ERP_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await exportGameProducts({ token: 'test-token', fields: ['sku', 'price'] });
    assert.equal(result.taskId, '42');
    assert.equal(result.file.toString(), 'PKsample');
    submitted = false;
    exportRoute = '/products/game-product-list/disuse-product-export';
    const retired = await exportGameProducts({ token: 'test-token', fields: ['sku', 'price'], disused: true });
    assert.equal(retired.taskId, '42');
    assert.equal(retired.file.toString(), 'PKsample');
  } finally {
    if (previous === undefined) delete process.env.NEW_ERP_BASE_URL;
    else process.env.NEW_ERP_BASE_URL = previous;
    await new Promise(resolve => server.close(resolve));
  }
});

test('stocking inbound counts only linked backup assembly receipts for the exact SKU', () => {
  const { summarize } = require(path.join(scriptsRoot, 'stocking-assembly-inbound.js'));
  const inventory = [
    { id: 1, sku: 'DEMO-SKU-002', action_name: '入库', in_out_remark: '拼装物料组合SKU:DEMO-SKU-002_1', purchase_orderid: 'PZ1', put_num: '467' },
    { id: 2, sku: 'DEMO-SKU-002', action_name: '入库', in_out_remark: '其他--采购进货', purchase_orderid: 'PZ1', put_num: '500' },
    { id: 3, sku: 'DEMO-SKU-002WS', action_name: '入库', in_out_remark: '拼装物料组合SKU:DEMO-SKU-002WS_1', purchase_orderid: 'PZ1', put_num: '100' },
    { id: 4, sku: 'DEMO-SKU-002', action_name: '入库', in_out_remark: '拼装物料组合SKU:DEMO-SKU-002_2', purchase_orderid: 'PZ2', put_num: '200' },
  ];
  const tasks = [{ id: 10, sku: 'DEMO-SKU-002', pz_no: 'PZ1', type: '2' }, { id: 11, sku: 'DEMO-SKU-002', pz_no: 'PZ2', type: '1' }];
  const result = summarize('DEMO-SKU-002', inventory, tasks);
  assert.equal(result.quantity, 467);
  assert.deepEqual(result.records.map((row) => row.inventoryId), [1]);
});

function runScript(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(scriptsRoot, 'new-erp.js'),
      commandForScript(script),
      ...args,
    ], {
      cwd: root,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function commandForScript(script) {
  const command = script.replace(/\.js$/, '');
  return command === 'erp-options' ? 'options' : command;
}

test('packing APIs preserve scope and export only the matching native task', async (t) => {
  const { packingOrderList, exportPackingDetails } = await import('new-erp-scripts');
  const options = { token: 'test-token', project: 'YS', warehouses: ['DEMO-DEST', 'OVERSEAS'],
    startDate: '2026-09-01', endDate: '2026-09-30' };
  const query = { auction_site: 'YS', site_type: 'DEMO-DEST,OVERSEAS', status: '',
    time_type: 'out_time', scan_date: '2026-09-01 00:00:00 & 2026-09-30 23:59:59' };
  let mode = 'complete', submitted = false, polls = 0, clock = 0;
  const calls = [];
  const originalTimeout = global.setTimeout;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(global, 'setTimeout', (callback, delay, ...args) => originalTimeout(callback, delay === 3000 ? 0 : delay, ...args));
  const task = (id, condition = query, status = '3') => ({ id, route_url: 'warehouse/packing-order/down-packing-detail',
    add_condition: JSON.stringify(condition), status });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const route = url.searchParams.get('r');
    calls.push(route);
    assert.equal(request.headers.token, 'test-token');
    if (route === '/warehouse/packing-order/list') {
      for (const [key, value] of Object.entries(query)) assert.equal(url.searchParams.get(key), value);
      assert.equal(url.searchParams.has('dest_type'), false);
      const list = mode === 'empty' ? [] : [{ id: 'box1', site_type: mode === 'foreign' ? 'OTHER' : 'OVERSEAS' }];
      const totalCount = mode === 'bad-total' ? null : mode === 'empty' ? 0 : 1;
      response.end(JSON.stringify({ code: 200, data: { list, totalCount } }));
    } else if (route === '/warehouse/packing-order/down-packing-detail') {
      for (const [key, value] of Object.entries(query)) assert.equal(url.searchParams.get(key), value);
      assert.equal(url.searchParams.has('page'), false);
      submitted = true;
      response.end(JSON.stringify({ code: 200, data: {} }));
    } else if (route === '/settings/download-center/index') {
      const list = [task('old')];
      if (submitted) {
        polls++;
        list.push(task('other', { ...query, auction_site: 'JY' }), { ...task('malformed'), add_condition: 'not-json' });
        if (mode === 'timeout') clock += 20 * 60_000;
        else {
          const status = mode === 'failed' ? '4' : mode === 'pending' && polls === 1 ? '2' : '3';
          list.push({ ...task('new', query, status), error_reason: '暂无数据' });
          if (mode === 'ambiguous') list.push(task('new2'));
        }
      }
      response.end(JSON.stringify({ code: 200, data: { list } }));
    } else if (route === '/settings/download-center/download-file') {
      assert.equal(url.searchParams.get('id'), 'new');
      if (mode !== 'missing-attachment') response.setHeader('content-disposition', 'attachment; filename=packing.xlsx');
      response.end(mode === 'bad-file' ? 'not an xlsx' : 'PKnative-xlsx');
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previousUrl = process.env.NEW_ERP_BASE_URL;
  process.env.NEW_ERP_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-packing-test-'));
  const reset = (value) => { mode = value; submitted = false; polls = 0; calls.length = 0; clock = 0; };
  try {
    const listing = await packingOrderList(options);
    assert.equal(listing.list[0].site_type, 'OVERSEAS');
    assert.equal(listing.totalCount, 1);
    assert.deepEqual(listing.query, query);
    assert.deepEqual(calls, ['/warehouse/packing-order/list']);
    reset('pending');
    const progress = [];
    const result = await exportPackingDetails({ ...options, onProgress: (value) => progress.push(value) });
    assert.equal(result.taskId, 'new');
    assert.equal(result.file.toString(), 'PKnative-xlsx');
    assert.equal(result.boxes, 1);
    assert.deepEqual(result.query, query);
    assert.deepEqual(progress.map((row) => row.stage), ['waiting', 'download']);
    assert.equal(polls, 2);
    assert.equal(calls.filter((route) => route.endsWith('/down-packing-detail')).length, 1);
    reset('empty');
    const empty = await exportPackingDetails(options);
    assert.equal(empty.file, null);
    assert.equal(empty.boxes, 0);
    assert.equal(empty.taskId, '');
    assert.deepEqual(calls, ['/warehouse/packing-order/list']);
    reset('complete');
    const output = path.join(directory, 'packing.xlsx');
    const written = await exportPackingDetails({ ...options, output });
    assert.equal(written.bytes, 13);
    assert.equal((await fs.readFile(output)).toString(), 'PKnative-xlsx');
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
    calls.length = 0;
    await assert.rejects(exportPackingDetails({ ...options, output }), /already exists/);
    assert.equal(calls.length, 0);
    reset('empty');
    const emptyOutput = path.join(directory, 'empty.xlsx');
    assert.equal((await exportPackingDetails({ ...options, output: emptyOutput })).output, null);
    await assert.rejects(fs.access(emptyOutput), { code: 'ENOENT' });
    for (const [scenario, message] of [['foreign', /outside/], ['bad-total', /pagination/],
      ['failed', /暂无数据/], ['ambiguous', /multiple matching/], ['timeout', /timed out/],
      ['bad-file', /not an XLSX/], ['missing-attachment', /download failed/]]) {
      reset(scenario);
      await assert.rejects(exportPackingDetails(options), message);
      assert.equal(calls.filter((route) => route.endsWith('/down-packing-detail')).length, ['foreign', 'bad-total'].includes(scenario) ? 0 : 1);
    }
    for (const invalid of [{ warehouses: [] }, { warehouses: ['DEMO-DEST', 'DEMO-DEST'] },
      { warehouses: ' DEMO-DEST' }, { warehouses: 'DEMO-DEST,' }, { warehouses: 'DEMO-DEST;OVERSEAS' },
      { startDate: '2026-02-30' }, { endDate: '2026-08-01' }, { project: '' }, { pageSize: 101 }]) {
      calls.length = 0;
      await assert.rejects(packingOrderList({ ...options, ...invalid }), /warehouses|Date|project|pageSize/);
      assert.equal(calls.length, 0);
    }
    reset('complete');
    const cliOptions = ['--token', 'test-token', '--project', 'YS', '--warehouses', 'DEMO-DEST,OVERSEAS',
      '--startDate', '2026-09-01', '--endDate', '2026-09-30'];
    const env = { ...process.env, NEW_ERP_CONFIG: '' };
    const cliList = await runScript('packing-order-list.js', cliOptions, env);
    assert.equal(cliList.status, 0, cliList.stderr);
    assert.equal(JSON.parse(cliList.stdout).totalCount, 1);
    const cliOutput = path.join(directory, 'cli.xlsx');
    const cliExport = await runScript('packing-detail-export.js', [...cliOptions, '--output', cliOutput], env);
    assert.equal(cliExport.status, 0, cliExport.stderr);
    assert.equal(JSON.parse(cliExport.stdout).taskId, 'new');
    assert.equal((await fs.readFile(cliOutput)).toString(), 'PKnative-xlsx');
    const missingOutput = await runScript('packing-detail-export.js', cliOptions, env);
    assert.notEqual(missingOutput.status, 0);
    assert.match(missingOutput.stderr, /output/);
  } finally {
    t.mock.restoreAll();
    if (previousUrl === undefined) delete process.env.NEW_ERP_BASE_URL;
    else process.env.NEW_ERP_BASE_URL = previousUrl;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('each subcommand exposes unified help', () => {
  for (const script of scripts) {
    const command = commandForScript(script);
    const result = spawnSync(process.execPath, [
      path.join(scriptsRoot, 'new-erp.js'), command, '--help',
    ], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${script} failed: ${result.stderr}`);
    assert.equal(result.stdout.split('\n')[0], `Usage: new-erp ${command} [options]`);
  }
});

test('invalid input fails without contacting the ERP', () => {
  const result = spawnSync(process.execPath, [
    path.join(scriptsRoot, 'new-erp.js'),
    'sales-volume-ranking',
    '--startDate', 'not-a-date',
    '--endDate', '2026-01-01',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /startDate/);
});

test('a command logs in and queries the ERP with native Node APIs', async () => {
  const calls = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      calls.push({ url, headers: request.headers, body });
      response.setHeader('content-type', 'application/json');
      if (url.searchParams.get('r') === '/user/check-login') {
        response.end(JSON.stringify({ code: 200, data: { token: 'mock-token' } }));
        return;
      }
      response.end(JSON.stringify({
        code: 200,
        data: {
          page: 1,
          pageSize: 20,
          totalCount: 1,
          list: [{
            id: 42,
            sku: 'ABC',
            name_cn: '测试产品',
            price: '12.5',
            pure_weight: '0.8',
            sale_in_7_days: '3',
            sale_in_30_days: '9',
            sku_info: { product_type_text: '顶级物料' },
          }],
        },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const result = await runScript('game-product-list.js', [
      '--sku', 'ABC',
      '--username', 'user',
      '--password', 'pass',
    ], {
      ...process.env,
      NEW_ERP_BASE_URL: `http://127.0.0.1:${address.port}`,
      NEW_ERP_TOKEN: '',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.searchParams.get('r'), '/user/check-login');
    assert.equal(calls[1].url.searchParams.get('r'), '/products/game-product-list/index');
    assert.equal(calls[1].headers.token, 'mock-token');
    assert.deepEqual(JSON.parse(result.stdout), [{
      id: 42,
      sku: 'ABC',
      nameCn: '测试产品',
      productType: '顶级物料',
      skuType: null,
      packVersion: null,
      bomStatus: null,
      saleStatus: null,
      purchaser: null,
      developer: null,
      stockUser: null,
      price: 12.5,
      pureWeight: 0.8,
      saleIn7Days: 3,
      saleIn30Days: 9,
      totalCount: 1,
      imageUrl: null,
      rawJson: null,
    }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('sales command expands a parent catalog from the ERP without catalog map config', async () => {
  const calls = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    calls.push(url);
    response.setHeader('content-type', 'application/json');
    if (url.searchParams.get('r') === '/products/game-product-list/selected-options') {
      response.end(JSON.stringify({ code: 200, data: { catalog_list: [{
        id: 10,
        name_cn: '父类',
        son: [{ id: 11, parent: 10, name_cn: '子类' }],
      }] } }));
      return;
    }
    response.end(JSON.stringify({
      code: 200,
      data: {
        totalCount: 1,
        list: [{ sku: 'ABC', catalog_name_cn: '子类', sales_sum: 1, mean: 1 }],
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const result = await runScript('sales-volume-ranking.js', [
      '--startDate', '2026-01-01',
      '--endDate', '2026-01-31',
      '--catalogId', '10',
      '--token', 'mock-token',
    ], {
      ...process.env,
      NEW_ERP_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls[0].searchParams.get('r'), '/products/game-product-list/selected-options');
    assert.equal(calls[1].searchParams.get('catalog_id'), '10,11');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('sales SKU search removes ERP prefix matches and sends platform options', async () => {
  const calls = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    calls.push(url);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ code: 200, data: { totalCount: 2, list: [
      { sku: 'ABC', auction_site_type: 'Amazon', sales_sum: 3 },
      { sku: 'ABCD', auction_site_type: 'Amazon', sales_sum: 7 },
    ] } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runScript('sales-volume-ranking.js', [
      '--startDate', '2026-01-01', '--endDate', '2026-01-31', '--sku', 'ABC',
      '--aggregateBy', 'sku-platform', '--auctionSiteType', 'Amazon', '--token', 'mock-token',
    ], { ...process.env, NEW_ERP_BASE_URL: `http://127.0.0.1:${server.address().port}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls[0].searchParams.get('aggregate_by'), 'sku-platform');
    assert.equal(calls[0].searchParams.get('auction_site_type'), 'Amazon');
    assert.equal(calls[0].searchParams.get('sku'), 'ABC');
    assert.deepEqual(JSON.parse(result.stdout).map((row) => [row.sku, row.sales, row.totalCount]), [['ABC', 3, 1]]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('plan evidence reads detail and keeps only exact SKU rows', async () => {
  const calls = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    calls.push(url);
    response.setHeader('content-type', 'application/json');
    const data = url.searchParams.get('r') === '/warehouse/sales-plan-order/view-detail'
      ? { data: [{ sku: 'ABC', num: 4 }, { sku: 'ABCD', num: 40 }, { sku: 'ABC', num: 5 }] }
      : { totalCount: 1, list: [{ id: 7, confirmed_no: 'P7', sku: 'ABCD', num: 49, add_time: '2026-01-03' }] };
    response.end(JSON.stringify({ code: 200, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runScript('supply-evidence.js', [
      '--source', 'plan', '--sku', 'ABC', '--startDate', '2026-01-01', '--endDate', '2026-01-31', '--token', 'mock-token',
    ], { ...process.env, NEW_ERP_BASE_URL: `http://127.0.0.1:${server.address().port}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls[0].searchParams.get('add_time'), '2026-01-01 00:00:00 & 2026-01-31 23:59:59');
    assert.equal(calls[1].searchParams.get('id'), '7');
    assert.equal(calls[1].searchParams.get('confirmed_no'), 'P7');
    assert.deepEqual(JSON.parse(result.stdout).map((row) => row.plannedNum), [4, 5]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('platform export reuses a finished task and saves its CSV without resubmitting', async () => {
  const calls = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    calls.push(url.searchParams.get('r'));
    if (url.searchParams.get('r') === '/settings/download-center/download-file') {
      response.setHeader('content-disposition', 'attachment; filename="sales.csv"');
      response.end('platform,sales\nAmazon,3\n');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ code: 200, data: { list: [{
      id: 9, status: 3, start_date: '2026-01-01 00:00:00', end_date: '2026-01-31 23:59:59',
      add_condition: JSON.stringify({ params: { mode: 'domain', aggregate_by: 'platform',
        date_dimension: 'monthly', date_range: '2026-01-01 00:00:00 & 2026-01-31 23:59:59', index: 'sales-volume' } }),
    }] } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'new-erp-export-'));
  const output = path.join(tempDir, 'sales.csv');
  try {
    const result = await runScript('sales-volume-export.js', [
      '--startDate', '2026-01-01', '--endDate', '2026-01-31', '--aggregateBy', 'platform',
      '--output', output, '--token', 'mock-token',
    ], { ...process.env, NEW_ERP_BASE_URL: `http://127.0.0.1:${server.address().port}` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, ['/settings/download-center/index', '/settings/download-center/download-file']);
    assert.equal(await fs.readFile(output, 'utf8'), 'platform,sales\nAmazon,3\n');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('an optional config file supplies the ERP base URL and env wins', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      code: 200,
      data: {
        product_basic_info: { id: 42, sku: 'ABC', name_cn: '测试产品' },
        product_sku_version_list: [],
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'new-erp-config-'));
  const configPath = path.join(tempDir, 'config.json');
  const address = server.address();
  await fs.writeFile(configPath, JSON.stringify({
    baseUrl: `http://127.0.0.1:${address.port}`,
  }));

  try {
    const result = await runScript('product-detail.js', [
      '--id', '42',
      '--token', 'mock-token',
    ], {
      ...process.env,
      NEW_ERP_CONFIG: configPath,
      NEW_ERP_BASE_URL: '',
      NEW_ERP_TOKEN: '',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].id, 42);

    await fs.writeFile(configPath, JSON.stringify({ baseUrl: 'http://127.0.0.1:1' }));
    const overrideResult = await runScript('product-detail.js', [
      '--id', '42',
      '--token', 'mock-token',
    ], {
      ...process.env,
      NEW_ERP_CONFIG: configPath,
      NEW_ERP_BASE_URL: `http://127.0.0.1:${address.port}`,
      NEW_ERP_TOKEN: '',
    });

    assert.equal(overrideResult.status, 0, overrideResult.stderr);
    assert.equal(JSON.parse(overrideResult.stdout)[0].id, 42);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
