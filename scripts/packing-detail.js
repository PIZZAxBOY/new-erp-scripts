#!/usr/bin/env node
const { ArgumentError, CommandExecutionError, runCli } = require('./shared.js');
const { authArgs, selectionValue, queryData } = require('./query.js');

const args = [
  { name: 'packingNumNo', type: 'string', help: '原箱号 packing_num_no（必填）' },
  { name: 'stockFrom', type: 'string', help: '发货仓代码（必填）' },
  { name: 'status', type: 'string', help: '列表中的原箱状态，允许0（必填）' },
  { name: 'siteType', type: 'string', help: '列表中的完整目的仓代码（必填）' },
  ...authArgs,
];

async function main(options = {}) {
  const query = { packing_num_no: selectionValue(options.packingNumNo, 'packingNumNo'),
    stock_from: selectionValue(options.stockFrom, 'stockFrom'),
    site_type: selectionValue(options.siteType, 'siteType') };
  if (!['string', 'number'].includes(typeof options.status) || !/^-?\d+$/.test(String(options.status))) {
    throw new ArgumentError('status must be the integer status from the packing list');
  }
  query.status = String(options.status);
  const { data, source } = await queryData('/warehouse/transfer-order-packing/packing-detail', query, options);
  if (data.packing_num_no !== query.packing_num_no || data.stock_from !== query.stock_from
    || (data.site_type !== undefined && data.site_type !== query.site_type)
    || !Array.isArray(data.packing_sku)
    || data.packing_sku.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new CommandExecutionError('ERP packing detail does not match the requested box or warehouse, or has invalid packing_sku');
  }
  return { ...data, source };
}

module.exports = { main };
if (require.main === module) runCli({ name: 'packing-detail', description: '只读原箱SKU、数量和箱重尺寸；核对箱号及发货仓，保留原值。', args, func: main });
