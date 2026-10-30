#!/usr/bin/env node
const { ArgumentError, CommandExecutionError, requiredString, runCli } = require('./shared.js');
const { enumValue, listArgs, queryList, selectionValue } = require('./query.js');

const args = [
  { name: 'searchType', type: 'string', help: '搜索类型：1跟踪号、2转单号、3系统单号（默认）、4红人编码、5邮箱、6 SKU；须配合 searchValue' },
  { name: 'searchValue', type: 'string', help: '搜索内容；按 ERP 原生搜索规则匹配' },
  { name: 'project', type: 'string', help: 'ERP 项目代码，对应 auction_site' },
  { name: 'status', type: 'string', default: '', help: 'ERP 订单状态代码；默认空白表示全部状态' },
  { name: 'transactionId', type: 'string', help: '交易号，对应 transaction_id（不是系统单号）' },
  ...listArgs,
];

async function main(options = {}) {
  const status = String(options.status ?? '');
  if (status !== '' && !/^-?\d+$/.test(status)) {
    throw new ArgumentError('status must be an ERP integer status code or an empty string');
  }
  const query = { order_status: status };
  if (options.searchType !== undefined || options.searchValue !== undefined) {
    query.search_type = enumValue(options.searchType, '3', ['1', '2', '3', '4', '5', '6'], 'searchType');
    query.search_value = requiredString(options.searchValue, 'searchValue');
  }
  if (options.project !== undefined) query.auction_site = selectionValue(options.project, 'project');
  if (options.transactionId !== undefined) query.transaction_id = requiredString(options.transactionId, 'transactionId');
  return queryList('/marketing/market-order/index', query, options, (row) => {
    if (row.id === undefined || row.id === null || String(row.id).trim() === '') {
      throw new CommandExecutionError('ERP market order list returned a record without an id');
    }
    return String(row.id);
  });
}

module.exports = { main };
if (require.main === module) {
  runCli({ name: 'market-order-list', description: '只读市场订单列表，保留订单、SKU、物流及实时枚举原字段；支持分页与 fetchAll。', args, func: main });
}
