#!/usr/bin/env node
const { runCli } = require('./shared.js');
const { authArgs, enumValue, queryData } = require('./query.js');

const sources = {
  inventory: ['/warehouse/inventory/inventory-detail-options', { warehouse_type: '1', deal_type: '1' }],
  packing: ['/warehouse/packing-order/selected-options', {}],
  batchWarehouses: ['/warehouse/transfer-order-packing/get-stock-list', {}],
};
const args = [
  { name: 'source', type: 'string', default: '', help: 'inventory / packing / batchWarehouses（必填）' },
  ...authArgs,
];

async function main(options = {}) {
  const key = enumValue(options.source, '', Object.keys(sources), 'source');
  const [route, query] = sources[key];
  const { data, source } = await queryData(route, query, options);
  return { data, source };
}

module.exports = { main };
if (require.main === module) runCli({ name: 'erp-options', description: '读取ERP实时仓库、状态等枚举，不推断业务状态含义。', args, func: main });
