const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { failure } = require('./mcp-job-store.js');
const { expectedPeriods } = require('./sales-export-cache.js');

const MAX_BYTES = 64 * 1024 * 1024;
const PAGE_BYTES = 24000;
const resultErrors = {
  RESULT_NOT_READY: '任务尚未成功完成，请通过 jobs.status 查询原任务，不要重新导出。',
  RESULT_UNSUPPORTED: '此接口只读取 JSON list 结果；CSV、XLSX 和 NDJSON 请使用认证下载。',
  RESULT_UNSAFE: '结果文件安全或完整性检查失败，请联系服务管理员。',
  RESULT_ROW_TOO_LARGE: '单条记录超过响应预算；请用 fields 选择必要字段后读取。不会截断记录。',
  SALES_SUMMARY_INCOMPLETE: '汇总需要完整的 export SKU 月/年排名结果；不能汇总部分分页、列表来源或平台混合口径。',
  SALES_SUMMARY_INVALID: '销量结果的 SKU、期间、小计或数值校验失败，未返回部分汇总。',
};
const fail = code => { throw failure(code, resultErrors[code]); };

async function loadResult(record, store) {
  if (record.state !== 'succeeded') fail('RESULT_NOT_READY');
  if (record.result && Object.hasOwn(record.result, 'data')) return record.result.data;
  const artifact = record.result?.artifact;
  if (!artifact || artifact.mediaType !== 'application/json') fail('RESULT_UNSUPPORTED');
  const file = path.join(store.jobDir(record.jobId), 'result.json');
  if (artifact.complete !== true || artifact.path !== file) fail('RESULT_UNSAFE');
  let handle;
  try {
    if (await fs.realpath(store.root) !== store.root) fail('RESULT_UNSAFE');
    for (const directory of [store.jobsDir, store.jobDir(record.jobId)]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || (process.platform !== 'win32' && (stat.mode & 0o077))) fail('RESULT_UNSAFE');
    }
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.size !== artifact.bytes
      || (process.platform !== 'win32' && (stat.mode & 0o077))) fail('RESULT_UNSAFE');
    return JSON.parse(await handle.readFile('utf8'));
  } catch { fail('RESULT_UNSAFE'); }
  finally { await handle?.close(); }
}

function resultPage(data, { offset = 0, limit = 20, fields } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || (fields !== undefined && (!Array.isArray(fields) || !fields.length || fields.length > 30
      || fields.some(field => typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(field))))) {
    throw failure('INVALID_INPUT', 'Invalid offset, limit or fields.');
  }
  if (!Array.isArray(data?.list)) fail('RESULT_UNSUPPORTED');
  const list = [];
  for (const row of data.list.slice(offset, offset + limit)) {
    const selected = fields ? Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])) : row;
    if (Buffer.byteLength(JSON.stringify([...list, selected])) > PAGE_BYTES) {
      if (!list.length) fail('RESULT_ROW_TOO_LARGE');
      break;
    }
    list.push(selected);
  }
  const nextOffset = offset + list.length < data.list.length ? offset + list.length : null;
  return { list, offset, returnedCount: list.length, storedRowCount: data.list.length, nextOffset,
    hasMore: nextOffset !== null, scope: 'stored-result-only' };
}

function salesSummary(record, data) {
  const params = record.params || {};
  const rows = data?.list;
  if (record.operation !== 'sales_volume_ranking' || (params.source || 'export') !== 'export'
    || (params.aggregateBy || 'sku') !== 'sku' || !['monthly', 'yearly'].includes(params.dateDimension || 'monthly')
    || !Array.isArray(rows) || !rows.length
    || rows.some(row => row.totalCount !== rows.length || row.source !== 'export')) fail('SALES_SUMMARY_INCOMPLETE');
  const labels = expectedPeriods({ start: params.startDate, end: params.endDate,
    query: { date_dimension: params.dateDimension || 'monthly' } });
  if (!labels.length || labels.length > 240) fail('SALES_SUMMARY_INVALID');
  const totals = new Map(labels.map(label => [label, 0]));
  const seen = new Set();
  let totalSales = 0;
  function add(a, b) {
    const sum = a + b;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(sum)) fail('SALES_SUMMARY_INVALID');
    return sum;
  }
  for (const row of rows) {
    if (typeof row.sku !== 'string' || !row.sku || seen.has(row.sku)) fail('SALES_SUMMARY_INVALID');
    seen.add(row.sku);
    let periods;
    try { periods = typeof row.periodValues === 'string' ? JSON.parse(row.periodValues) : row.periodValues; }
    catch { fail('SALES_SUMMARY_INVALID'); }
    if (!Array.isArray(periods) || periods.length !== labels.length) fail('SALES_SUMMARY_INVALID');
    const dates = new Set();
    let subtotal = 0;
    for (const period of periods) {
      const date = String(period?.date).replace(/^(\d{4})年(?:(\d{1,2})月)?$/, (_, year, month) => month ? `${year}-${month.padStart(2, '0')}` : year);
      if (!totals.has(date) || dates.has(date)) fail('SALES_SUMMARY_INVALID');
      dates.add(date);
      subtotal = add(subtotal, period.value);
      totals.set(date, add(totals.get(date), period.value));
    }
    if (subtotal !== row.sales) fail('SALES_SUMMARY_INVALID');
    totalSales = add(totalSales, row.sales);
  }
  if ([...totals.values()].reduce(add, 0) !== totalSales) fail('SALES_SUMMARY_INVALID');
  const query = Object.fromEntries(['startDate', 'endDate', 'auctionSite', 'auctionSiteType', 'sku',
    'aggregateBy', 'catalogId', 'productTypeCate', 'dateDimension'].filter(key => params[key] !== undefined).map(key => [key, params[key]]));
  return { jobId: record.jobId, query, completedAt: record.updatedAt, skuCount: rows.length,
    totalSales, periods: [...totals].map(([date, sales]) => ({ date, sales })),
    complete: true, source: 'stored-job-result', freshness: '原任务结果，未重新查询 ERP；期间数值仅覆盖原始起止时间。' };
}

module.exports = { loadResult, resultPage, salesSummary, resultErrors };
