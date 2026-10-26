#!/usr/bin/env node
const { CommandExecutionError, requiredString, runCli } = require('./shared.js');
const { listArgs, enumValue, selectionValue, queryList } = require('./query.js');

const args = [
  { name: 'stockFrom', type: 'string', default: '', help: '发货仓代码，从 ERP 枚举获取（必填）' },
  { name: 'status', type: 'string', default: '5', help: '配货状态 dk_status，默认5=已配货待装箱，空字符串=全部' },
  { name: 'batchNo', type: 'string', default: '', help: '批次号 confirmed_no 搜索条件' },
  { name: 'packingNo', type: 'string', help: '精确总单号 packing_no' },
  { name: 'warehouse', type: 'string', default: '', help: '目的仓 site_type' },
  ...listArgs,
];

async function main(options = {}) {
  const query = { stock_from: requiredString(options.stockFrom, 'stockFrom'),
    dk_status: enumValue(options.status, '5', ['', '1', '2', '3', '4', '5', '6'], 'status') };
  if (options.batchNo) query.confirmed_no = requiredString(options.batchNo, 'batchNo');
  if (options.warehouse) query.site_type = requiredString(options.warehouse, 'warehouse');
  if (options.packingNo !== undefined) query.packing_no = selectionValue(options.packingNo, 'packingNo');
  const result = await queryList('/warehouse/transfer-order-packing/list', query, options);
  if (result.list.some((row) => row.stock_from !== query.stock_from
    || (query.dk_status && String(row.dk_status) !== query.dk_status)
    || (query.site_type && row.site_type !== query.site_type)
    || (query.packing_no && row.packing_no !== query.packing_no))) {
    throw new CommandExecutionError('ERP packing batch list returned a warehouse, status or packing number outside the requested selection');
  }
  return result;
}

module.exports = { main };
if (require.main === module) runCli({ name: 'packing-batch-list', description: '查询配货批次，默认已配货待装箱；不代表已核验上游调拨签收。', args, func: main });
