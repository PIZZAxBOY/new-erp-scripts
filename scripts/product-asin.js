const { CommandExecutionError, EmptyResultError, positiveInteger } = require('./shared.js');
const { queryData, queryList } = require('./query.js');

const OPTIONS_ROUTE = '/sales/ling-xing/jy-amazon-selected-option';
const LISTING_ROUTE = '/sales/ling-xing/jy-amazon-list-data';
const PRODUCT_ROUTE = '/products/game-product-list/index';
const DISCONTINUED_PRODUCT_ROUTE = '/products/game-product-list/game-disuse-product-list';

async function productsForAsin(asin, { token, maxPages }) {
  const { data: options } = await queryData(OPTIONS_ROUTE, {}, { token });
  const fields = options.other_select_name1_arr;
  const asinFields = fields && typeof fields === 'object'
    ? Object.entries(fields).filter(([, label]) => typeof label === 'string' && label.trim().toUpperCase() === 'ASIN') : [];
  if (asinFields.length !== 1) {
    throw new CommandExecutionError('ERP ASIN search option is missing or ambiguous; cannot select a search field');
  }
  const pagination = { token, page: 1, pageSize: 100, fetchAll: true, maxPages };
  const listings = await queryList(LISTING_ROUTE,
    { other_select_name1: asinFields[0][0], other_select_value1: asin }, pagination, JSON.stringify);
  if (listings.list.some((row) => typeof row.asin !== 'string' || !row.asin.trim())) {
    throw new CommandExecutionError('ERP listing returned a record without ASIN; cannot verify the search result');
  }
  const matched = listings.list.filter((row) => row.asin.trim().toUpperCase() === asin);
  if (!matched.length) throw new EmptyResultError('new-erp product-detail', `No ERP listing found for ASIN ${asin}`);
  const groups = new Map();
  for (const row of matched) {
    if (typeof row.sku !== 'string' || !row.sku.trim()) {
      throw new CommandExecutionError('ERP ASIN listing has no paired ERP SKU; cannot fetch product details');
    }
    const sku = row.sku.trim();
    if (!groups.has(sku)) groups.set(sku, []);
    groups.get(sku).push(row);
  }
  const products = [];
  const source = { ...listings.source, totalCount: listings.totalCount,
    fetchedCount: listings.fetchedCount, complete: listings.complete, matchedCount: matched.length };
  for (const [sku, asinListings] of groups) {
    let exact = [];
    for (const route of [PRODUCT_ROUTE, DISCONTINUED_PRODUCT_ROUTE]) {
      const result = await queryList(route, { sku }, pagination);
      exact = result.list.filter((row) => (row.sku ?? row.sku_info?.sku) === sku);
      if (exact.length) break;
    }
    if (!exact.length) throw new EmptyResultError('new-erp product-detail', `No ERP product found for ASIN ${asin}, SKU ${sku}`);
    for (const row of exact) {
      const id = positiveInteger(row.id, undefined, 'ERP product id');
      products.push({ id, sku, asinListings, asinSource: source });
    }
  }
  return products;
}

module.exports = { productsForAsin };
