#!/usr/bin/env node
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const commands = Object.freeze({
  'market-order-list': { kind: 'read', script: 'market-order-list.js', description: '查询市场订单与订单原始字段' },
  'catalog-list': { kind: 'read', script: 'catalog-list.js', description: '查找商品分类与分类 ID' },
  'category-summary': { kind: 'read', script: 'category-summary.js', description: '按分类统计匹配的 SKU 销售记录' },
  'game-product-batch': { kind: 'read', script: 'game-product-batch.js', description: '批量查询多个商品 SKU' },
  'game-product-list': { kind: 'read', script: 'game-product-list.js', description: '按 SKU、名称或分类搜索商品' },
  'product-detail': { kind: 'read', script: 'product-detail.js', description: '按商品 ID 或 ASIN 查询 ERP 商品详情与图片' },
  'sales-volume-ranking': { kind: 'read', script: 'sales-volume-ranking.js', description: '查询日期范围内的 SKU 销量排名' },
  'sales-volume-export': { kind: 'export', script: 'sales-volume-export.js', description: '异步导出销量 CSV' },
  'supply-evidence': { kind: 'read', script: 'supply-evidence.js', description: '查询计划、库存及货物流转凭证' },
  'stocking-assembly-inbound': { kind: 'read', script: 'stocking-assembly-inbound.js', description: '统计备货拼装的实际入库数量' },
  'packing-order-list': { kind: 'read', script: 'packing-order-list.js', description: '查询装箱单列表' },
  'packing-order-pages': { kind: 'stream', script: 'packing-order-pages.js', description: '逐页读取装箱记录并输出 NDJSON' },
  'packing-detail': { kind: 'read', script: 'packing-detail.js', description: '查询单箱明细' },
  'plan-delivery-order-list': { kind: 'read', script: 'plan-delivery-order-list.js', description: '查询历史配货明细' },
  'packing-detail-export': { kind: 'export', script: 'packing-detail-export.js', description: '导出装箱明细 XLSX' },
  'packing-batch-list': { kind: 'read', script: 'packing-batch-list.js', description: '查询配货批次' },
  'packing-batch-detail': { kind: 'read', script: 'packing-batch-detail.js', description: '查询配货批次的 SKU 与 BOM 明细' },
  'outer-package-list': { kind: 'read', script: 'outer-package-list.js', description: '查询外包装规格与版本' },
  'inventory-list': { kind: 'read', script: 'inventory-list.js', description: '查询库存批次或仓库汇总' },
  'logistics-channel-list': { kind: 'read', script: 'logistics-channel-list.js', description: '查询物流渠道与运输方式' },
  'product-declaration-list': { kind: 'read', script: 'product-declaration-list.js', description: '查询商品申报主数据' },
  options: { kind: 'read', script: 'erp-options.js', description: '读取实时仓库、状态等枚举' },
  login: { kind: 'local', script: 'login.js', description: '登录 ERP 并在本机保存 token' },
  logout: { kind: 'local', script: 'logout.js', description: '删除本机保存的登录会话' },
  setup: { kind: 'local', script: 'setup.js', description: '将本地 MCP 注册到 Codex' },
  mcp: { kind: 'local', script: 'mcp.js', description: '启动本地 stdio MCP' },
});

function formatHelp() {
  const width = Math.max(...Object.keys(commands).map((name) => name.length));
  const lines = [
    'Usage: new-erp <command> [options]',
    '',
    'Commands:',
    ...Object.entries(commands).map(([name, command]) =>
      `  ${name.padEnd(width)}  ${command.description}`),
    '',
    'Examples:',
    '  new-erp game-product-list --sku DEMO-SKU-001',
    '  new-erp market-order-list --searchValue DEMO-ORDER-ID',
    '',
    'Run "new-erp <command> --help" for command options.',
  ];
  return `${lines.join('\n')}\n`;
}

function usageError(message) {
  process.stderr.write(`Error: ${message}\nRun "new-erp --help" for available commands.\n`);
  return 2;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    process.stdout.write(formatHelp());
    return 0;
  }

  const [name, ...args] = argv;
  if (name === '--help' || name === '-h') {
    if (args.length > 0) return usageError('top-level help does not accept additional arguments');
    process.stdout.write(formatHelp());
    return 0;
  }
  if (name.startsWith('-')) return usageError('unsupported top-level option');
  if (!Object.hasOwn(commands, name)) return usageError('unknown command');

  const result = spawnSync(process.execPath, [path.join(__dirname, commands[name].script), ...args], {
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write('Error: unable to start the requested command\n');
    return 1;
  }
  if (result.signal) {
    try {
      process.kill(process.pid, result.signal);
    } catch {
      return 128 + (os.constants.signals[result.signal] || 1);
    }
    return 128 + (os.constants.signals[result.signal] || 1);
  }
  return result.status ?? 1;
}

module.exports = { commands };
if (require.main === module) process.exitCode = main();
