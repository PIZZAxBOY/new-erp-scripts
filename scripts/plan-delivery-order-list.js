const { CommandExecutionError } = require('./shared.js');
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

module.exports = { main, args };
