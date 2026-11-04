const { requiredString } = require('./shared.js');
const { listArgs, queryList } = require('./query.js');

const args = [
  { name: 'sku', type: 'string', default: '', help: 'ERP SKU搜索条件，调用方需核验精确SKU' },
  { name: 'country', type: 'string', default: '', help: 'ERP国家代码，如 US/IT' },
  ...listArgs,
];

async function main(options = {}) {
  const query = {};
  if (options.sku) query.sku = requiredString(options.sku, 'sku');
  if (options.country) query.country = requiredString(options.country, 'country');
  return queryList('/products/product-declare-info/index', query, options);
}

module.exports = { main, args };
