#!/usr/bin/env node
const { requiredString, runCli } = require('./shared.js');
const { listArgs, enumValue, queryList } = require('./query.js');

const args = [
  { name: 'flowStatus', type: 'string', default: '', help: '1外包装SKU、2方装头程、3异装头程、4无BZ版本SKU、5无BZ版本头程（必填）' },
  { name: 'sku', type: 'string', default: '', help: 'ERP SKU搜索条件；可能匹配多个SKU/版本，调用方需精确筛选' },
  { name: 'project', type: 'string', default: '', help: '项目代码，从 ERP 枚举获取' },
  ...listArgs,
];

async function main(options = {}) {
  const flow = enumValue(options.flowStatus, '', ['1', '2', '3', '4', '5'], 'flowStatus');
  const query = { flow_status: flow };
  if (options.sku) query[['1', '4'].includes(flow) ? 'sku' : 'makeup_sku'] = requiredString(options.sku, 'sku');
  if (options.project) query.auction_site = requiredString(options.project, 'project');
  // Packaging rows can share a product ID; retain distinct versions/BOMs.
  return queryList('/products/outer-package-product/index', query, options, JSON.stringify);
}

module.exports = { main };
if (require.main === module) runCli({ name: 'outer-package-list', description: '读取外包装与各版本头程信息，包括箱规、数量、尺寸、重量及实时枚举。', args, func: main });
