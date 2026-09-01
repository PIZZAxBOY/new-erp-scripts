const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const scriptsRoot = path.join(root, '.agents', 'skills', 'new-erp-scripts', 'scripts');
const scripts = [
  'catalog-list.js',
  'category-summary.js',
  'game-product-batch.js',
  'game-product-list.js',
  'product-detail.js',
  'sales-volume-ranking.js',
];

function runScript(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsRoot, script), ...args], {
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

test('each command exposes a standalone help screen', () => {
  for (const script of scripts) {
    const result = spawnSync(process.execPath, [path.join(scriptsRoot, script), '--help'], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `${script} failed: ${result.stderr}`);
    assert.match(result.stdout, /^Usage:/m);
    assert.match(result.stdout, new RegExp(script.replace('.js', '')));
  }
});

test('invalid input fails without contacting the ERP', () => {
  const result = spawnSync(process.execPath, [
    path.join(scriptsRoot, 'sales-volume-ranking.js'),
    '--startDate', 'not-a-date',
    '--endDate', '2026-01-01',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
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
