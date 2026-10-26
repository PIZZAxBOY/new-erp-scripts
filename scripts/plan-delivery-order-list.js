#!/usr/bin/env node
const { CommandExecutionError, runCli } = require('./shared.js');
const { listArgs, selectionValue, queryList } = require('./query.js');

const args = [
  { name: 'stockFrom', type: 'string', help: '发货仓代码（必填）' },
  { name: 'packingNo', type: 'string', help: '精确总单号（必填）' },
  ...listArgs,
];

async function main(options = {}) {
  const query = { stock_from: selectionValue(options.stockFrom, 'stockFrom'),
    packing_no: selectionValue(options.packingNo, 'packingNo') };
  return queryList('/sales/plan-delivery-order/list', query, options, (row) => {
    if (row.stock_from !== query.stock_from || row.packing_no !== query.packing_no) {
      throw new CommandExecutionError('ERP plan delivery list returned a warehouse or packing number outside the requested selection');
    }
    if (row.id === undefined || row.id === null || String(row.id).trim() === '') {
      throw new CommandExecutionError('ERP plan delivery list returned a record without an id');
    }
    return String(row.id);
  });
}

module.exports = { main };
if (require.main === module) runCli({ name: 'plan-delivery-order-list', description: '按总单号及发货仓只读历史配货明细，保留版本、跟单及已装数量字段。', args, func: main });
