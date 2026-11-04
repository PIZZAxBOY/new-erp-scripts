const { parse } = require('csv-parse/sync');
const { CommandExecutionError } = require('./shared.js');

const FIELDS = {
  sku: ['sku'],
  sales_sum: ['sales_sum', 'value', '小计', '销量', '总销量', '销量合计'],
  auction_site: ['auction_site', '项目', '品牌'],
  auction_site_type: ['auction_site_type', '平台', '平台类型'],
  name_cn: ['name_cn', '品名', '中文名', '商品名称'],
  catalog_name_cn: ['catalog_name_cn', '类目', '分类'],
  mean: ['mean', '均值'],
  country_cn: ['country_cn', '国家'],
  image_url: ['image_url', '图片'],
};

function invalid(message) {
  return new CommandExecutionError(`sales CSV: ${message}`);
}

function number(value, required, row) {
  const text = value?.trim() ?? '';
  if (!text && !required) return null;
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) {
    throw invalid(`invalid numeric cell at row ${row}`);
  }
  const result = Number(text.replaceAll(',', ''));
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) {
    throw invalid(`numeric cell out of range at row ${row}`);
  }
  return result;
}

function parseSalesCsv(file, { aggregateBy = 'sku' } = {}) {
  let csv;
  try { csv = new TextDecoder('utf-8', { fatal: true }).decode(file); }
  catch {
    try { csv = new TextDecoder('gbk', { fatal: true }).decode(file); }
    catch { throw invalid('unsupported or malformed text encoding; expected UTF-8 or GBK'); }
  }
  let records;
  try { records = parse(csv, { bom: true, skip_empty_lines: true, max_record_size: 1024 * 1024 }); }
  catch { throw invalid('malformed CSV; check quoting and column counts'); }
  const headers = records.shift()?.map((value) => value.trim().toLowerCase());
  if (!headers?.length || headers.some((value) => !value) || new Set(headers).size !== headers.length) {
    throw invalid('missing, empty or duplicate headers');
  }
  const columns = {};
  for (const [field, aliases] of Object.entries(FIELDS)) {
    const matches = headers.flatMap((header, index) => aliases.includes(header) ? [index] : []);
    if (matches.length > 1) throw invalid(`ambiguous ${field} columns`);
    columns[field] = matches[0];
  }
  for (const field of ['sku', 'sales_sum', ...(aggregateBy === 'sku-platform' ? ['auction_site_type'] : [])]) {
    if (columns[field] === undefined) {
      const label = field === 'auction_site_type' ? 'platform (auction_site_type)' : field;
      throw invalid(`missing ${label} header; cannot infer totals or aggregation`);
    }
  }
  const periods = headers.flatMap((header, index) => /^(?:\d{4}(?:-(?:0[1-9]|1[0-2]))?|\d{4}年(?:(?:0?[1-9]|1[0-2])月)?)$/.test(header)
    ? [{ date: header, index }] : []);
  return records.map((values, index) => {
    const rowNumber = index + 2;
    const row = Object.fromEntries(Object.entries(columns).map(([field, column]) => [field, column === undefined ? null : values[column].trim()]));
    if (!row.sku) throw invalid(`missing SKU at row ${rowNumber}`);
    if (aggregateBy === 'sku-platform' && !row.auction_site_type) throw invalid(`missing platform at row ${rowNumber}`);
    row.sales_sum = number(row.sales_sum, true, rowNumber);
    row.mean = number(row.mean, false, rowNumber);
    row.statistics_rows = periods.map(({ date, index: column }) => ({ date, value: number(values[column], true, rowNumber) }));
    row.csv = Object.fromEntries(headers.map((header, column) => [header, values[column]]));
    return row;
  });
}

module.exports = { parseSalesCsv };
