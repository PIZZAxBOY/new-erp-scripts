const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

test('package retains the stable JavaScript API exports', async () => {
  const api = await import('new-erp-mcp');
  assert.deepEqual(Object.keys(api).sort(), [
    'marketOrderList', 'catalogList', 'categorySummary', 'exportGameProducts', 'exportOuterPackages',
    'gameProductBatch', 'gameProductList', 'productDetail', 'salesVolumeExport', 'salesVolumeRanking',
    'erpClient', 'stockingAssemblyInbound', 'supplyEvidence', 'packingOrderList', 'exportPackingDetails',
    'packingOrderPages', 'packingDetail', 'planDeliveryOrderList', 'packingBatchList', 'packingBatchDetail',
    'outerPackageList', 'inventoryList', 'logisticsChannelList', 'productDeclarationList', 'erpOptions',
  ].sort());
  assert.equal(typeof api.erpClient.loginToken, 'function');
  assert.equal(typeof api.erpClient.requestJson, 'function');
});

test('packed package exposes only the MCP launcher and serves two tools with 24 operations', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-mcp-package-'));
  try {
    const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(packed.status, 0, packed.stderr);
    const [archive] = JSON.parse(packed.stdout);
    assert.ok(archive.files.every(({ path: name }) => name === 'index.mjs'
      || name === 'package.json' || name === 'README.md' || name.startsWith('scripts/') || name.startsWith('docs/')));
    assert.equal(archive.files.some(({ path: name }) => name.startsWith('skills/')
      || /(?:^|\/)(?:new-erp|login|logout|setup|packing-order-pages)\.js$/.test(name)), false);

    const installed = spawnSync('npm', ['install', '--prefer-offline', '--prefix', directory,
      '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', path.join(directory, archive.filename)], {
      cwd: directory, encoding: 'utf8',
    });
    assert.equal(installed.status, 0, installed.stderr);
    const packageRoot = path.join(directory, 'node_modules', 'new-erp-mcp');
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import * as api from 'new-erp-mcp'; console.log(JSON.stringify(Object.keys(api).sort()))"], {
      cwd: directory, encoding: 'utf8',
    });
    assert.equal(imported.status, 0, imported.stderr);
    const checkoutExports = Object.keys(await import('new-erp-mcp')).sort();
    assert.deepEqual(JSON.parse(imported.stdout), checkoutExports);
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.bin, { 'new-erp-mcp': 'scripts/mcp.js' });
    assert.equal((await fs.readdir(path.join(directory, 'node_modules', '.bin'))).includes('new-erp'), false);
    const launcher = path.join(directory, 'node_modules', '.bin', 'new-erp-mcp');
    const secret = 'DO-NOT-ECHO-ARGUMENT-SECRET';
    const rejected = spawnSync(launcher, [`--token=${secret}`], { cwd: directory, encoding: 'utf8' });
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /does not accept command arguments/);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, new RegExp(secret));

    const { Client } = await import('@modelcontextprotocol/client');
    const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
    const client = new Client({ name: 'installed-package-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: launcher, cwd: directory,
      env: { ...process.env, NEW_ERP_SESSION_FILE: path.join(directory, 'missing-session.json'),
        NEW_ERP_CONFIG: path.join(directory, 'missing-config.json') }, stderr: 'pipe' });
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ['erp_discover', 'erp_execute']);
      const discovery = await client.callTool({ name: 'erp_discover', arguments: {} });
      const operations = JSON.parse(discovery.content[0].text).operations;
      assert.equal(operations.filter(({ name }) => !name.includes('.')).length, 24);
      assert.equal(operations.filter(({ name }) => name.includes('.')).length, 7);
      const missing = await client.callTool({ name: 'erp_execute',
        arguments: { operation: 'product_detail', params: { id: 1 } } });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /auth\.login/);
      assert.match(missing.content[0].text, /用户/);
      assert.doesNotMatch(missing.content[0].text, /new-erp\s+login/);
    } finally {
      await client.close();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
