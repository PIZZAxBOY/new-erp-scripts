#!/usr/bin/env node
const { CommandExecutionError, requiredString, runCli } = require('./shared.js');
const { listArgs, enumValue, queryList } = require('./query.js');

const args = [
  { name: 'sku', type: 'string', default: '', help: '精确SKU（必填）' },
  { name: 'stockCode', type: 'string', default: '', help: '仓库代码（必填）' },
  { name: 'groupBy', type: 'string', default: 'batch', help: 'batch=按库存批次/BOM分开；warehouse=SKU+仓库汇总' },
  ...listArgs,
];

async function main(options = {}) {
  const sku = requiredString(options.sku, 'sku');
  const stockCode = requiredString(options.stockCode, 'stockCode');
  const group = enumValue(options.groupBy, 'batch', ['batch', 'warehouse'], 'groupBy');
  const query = { warehouse_type: group === 'batch' ? '2' : '1', deal_type: '1', summary_basis: '1',
    select1_key: '1', select2_key: 'sku', select_value: sku, stock_code: stockCode, show_zero_count: '1' };
  // Inventory groups can share a product ID; retain distinct batches/BOMs.
  const result = await queryList('/warehouse/inventory/inventory-detail-list', query, options, JSON.stringify);
  if (result.list.some((row) => row.sku !== sku || row.stock_code !== stockCode)) {
    throw new CommandExecutionError('ERP inventory returned a SKU or warehouse outside the requested selection');
  }
  return result;
}

module.exports = { main };
if (require.main === module) runCli({ name: 'inventory-list', description: '读取国内仓即时、占用、在途和预计可用库存；预计可用不等于已签收可装箱。', args, func: main });
