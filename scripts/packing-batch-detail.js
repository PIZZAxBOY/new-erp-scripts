const { CommandExecutionError, requiredString } = require('./shared.js');
const { authArgs, queryData } = require('./query.js');

const args = [
  { name: 'stockFrom', type: 'string', default: '', help: '发货仓代码（必填）' },
  { name: 'batchNo', type: 'string', default: '', help: '批次号 confirmed_no（必填）' },
  ...authArgs,
];

async function main(options = {}) {
  const query = { stock_from: requiredString(options.stockFrom, 'stockFrom'),
    confirmed_no: requiredString(options.batchNo, 'batchNo') };
  const { data, source } = await queryData('/warehouse/transfer-order-packing/view-detail', query, options);
  if (data.confirmed_no !== query.confirmed_no || data.stock_from !== query.stock_from
    || !Array.isArray(data.provider) || data.provider.some((group) => !Array.isArray(group))) {
    throw new CommandExecutionError('ERP packing batch detail does not match the requested batch or has invalid provider groups');
  }
  return { ...data, source };
}

module.exports = { main, args };
