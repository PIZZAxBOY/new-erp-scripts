const {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  catalogNamesForIds,
  expandCatalogIds,
  fetchCatalogRows,
  getBaseUrl,
  resolveImageUrl,
  resolveToken,
  positiveInteger,
  requestJson,
  requiredString,
} = require('./shared.js');
const { checkDuplicateRows, validatePage } = require('./query.js');

const SORT_FIELDS = new Set(['sales', 'mean', 'sku', 'name']);
const SORT_ORDERS = new Set(['asc', 'desc']);
const AUCTION_SITE_CODES = ['JY', 'YS', 'HX', 'OG'];
const AUCTION_SITE_ALIASES = new Map([
  ['jy', 'JY'],
  ['exr', 'JY'],
  ['extremerate', 'JY'],
  ['ys', 'YS'],
  ['pv', 'YS'],
  ['playvital', 'YS'],
  ['hx', 'HX'],
  ['hex', 'HX'],
  ['hexgaming', 'HX'],
  ['og', 'OG'],
  ['ostrogear', 'OG'],
]);
const DATE_DIMENSIONS = new Set(['monthly', 'yearly']);
const AGGREGATE_BY = new Set(['sku', 'sku-platform']);
const PRODUCT_TYPE_CATE_MAP = new Map([
  ['5', '5'],
  ['顶级物料', '5'],
  ['6', '6'],
  ['二级物料', '6'],
]);
function normalizeAuctionSite(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const aliasKey = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const code = AUCTION_SITE_ALIASES.get(aliasKey);
  if (!code) {
    throw new ArgumentError(
      `auctionSite must resolve to ${AUCTION_SITE_CODES.join('/')} via EXR/eXtremeRate, PV/PlayVital, HEX/HexGaming, or OG/OstroGear`,
    );
  }
  return code;
}

function normalizeProductTypeCate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const normalized = PRODUCT_TYPE_CATE_MAP.get(text);
  if (!normalized) {
    throw new ArgumentError('productTypeCate must be 5/顶级物料 or 6/二级物料; pass an empty string to query all product types');
  }
  return normalized;
}

function normalizeDateTime(value, label, endOfDay) {
  const text = requiredString(value, label);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/);
  if (!match) {
    throw new ArgumentError(`${label} must use YYYY-MM-DD or YYYY-MM-DD HH:mm:ss`);
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hasTime = hourText !== undefined;
  const hour = hasTime ? Number(hourText) : endOfDay ? 23 : 0;
  const minute = hasTime ? Number(minuteText) : endOfDay ? 59 : 0;
  const second = hasTime ? Number(secondText) : endOfDay ? 59 : 0;
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const parsed = new Date(timestamp);

  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
    || parsed.getUTCSeconds() !== second
  ) {
    throw new ArgumentError(`${label} is not a valid calendar date/time`);
  }

  const pad = (number) => String(number).padStart(2, '0');
  return {
    text: `${yearText}-${monthText}-${dayText} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
    timestamp,
  };
}

function asFiniteNumber(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new CommandExecutionError(`new-erp sales-volume-ranking returned invalid ${label}: ${value}`);
  }
  return number;
}

function rawSortValue(row, sort) {
  if (sort === 'sales') return asFiniteNumber(row?.sales_sum, 'sales_sum');
  if (sort === 'mean') return asFiniteNumber(row?.mean, 'mean');
  if (sort === 'sku') return String(row?.sku ?? '').trim();
  return String(row?.name_cn ?? '').trim();
}

function compareNullable(left, right, direction) {
  const leftMissing = left === null || left === undefined || left === '';
  const rightMissing = right === null || right === undefined || right === '';
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;

  const compared = typeof left === 'number' && typeof right === 'number'
    ? left - right
    : String(left).localeCompare(String(right), 'en', { numeric: true, sensitivity: 'base' });
  return direction === 'desc' ? -compared : compared;
}

function outputRow(row, rank, totalCount, includeRaw) {
  const sku = String(row?.sku ?? '').trim();
  if (!sku) {
    throw new CommandExecutionError('new-erp sales-volume-ranking returned a row without sku');
  }

  const statistics = Array.isArray(row?.statistics_rows)
    ? row.statistics_rows.map((item) => ({
      date: String(item?.date ?? '').trim() || null,
      value: asFiniteNumber(item?.value, 'statistics_rows.value'),
    }))
    : [];

  return {
    rank,
    auctionSite: String(row?.auction_site ?? '').trim() || null,
    auctionSiteType: String(row?.auction_site_type ?? '').trim() || null,
    sku,
    nameCn: String(row?.name_cn ?? '').trim() || null,
    catalogNameCn: String(row?.catalog_name_cn ?? '').trim() || null,
    sales: asFiniteNumber(row?.sales_sum, 'sales_sum'),
    mean: asFiniteNumber(row?.mean, 'mean'),
    countryCn: String(row?.country_cn ?? '').trim() || null,
    periodValues: JSON.stringify(statistics),
    totalCount,
    imageUrl: resolveImageUrl(row?.full_image_url, row?.image_url),
    rawJson: includeRaw ? JSON.stringify(row) : null,
  };
}

async function fetchSalesPage({
  token,
  page,
  pageSize,
  startDateTime,
  endDateTime,
  auctionSite,
  auctionSiteType,
  sku,
  aggregateBy = 'sku',
  dateDimension,
  catalogId,
  productTypeCate,
  expectedCatalogNames,
  commandName = 'sales-volume-ranking',
}) {
  const url = new URL(`${getBaseUrl()}/index.php`);
  url.searchParams.set('r', '/statistics/sales-volume/list');
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('aggregate_by', aggregateBy);
  if (auctionSite) url.searchParams.set('auction_site', auctionSite);
  if (auctionSiteType) url.searchParams.set('auction_site_type', auctionSiteType);
  if (sku) url.searchParams.set('sku', sku);
  url.searchParams.set('date_dimension', dateDimension);
  url.searchParams.set('date_range', `${startDateTime} & ${endDateTime}`);
  url.searchParams.set('mode', 'sku');
  url.searchParams.set('index', 'sales-volume');
  if (catalogId) url.searchParams.set('catalog_id', catalogId);
  if (productTypeCate) url.searchParams.set('product_type_cate', productTypeCate);
  url.searchParams.set('_t', String(Date.now()));

  const json = await requestJson(url.href, {
    label: `new-erp ${commandName} page=${page}`,
    headers: { token },
  });
  if (!json?.data || !Array.isArray(json.data.list)) {
    throw new CommandExecutionError(
      `new-erp ${commandName} page=${page} returned unexpected response shape`,
    );
  }
  validatePage(json.data, page, pageSize, `new-erp ${commandName}`);
  if (productTypeCate && expectedCatalogNames?.size > 0) {
    const unexpectedRow = json.data.list.find((row) => {
      const catalogName = String(row?.catalog_name_cn ?? '').trim();
      return !expectedCatalogNames.has(catalogName);
    });
    if (unexpectedRow) {
      throw new CommandExecutionError(
        `new-erp ${commandName} ignored catalog_id while product_type_cate=${productTypeCate}; unexpected catalog_name_cn=${unexpectedRow.catalog_name_cn ?? '(empty)'}`,
      );
    }
  }
  return json.data;
}

const args = [
  { name: 'source', type: 'string', choices: ['export', 'list'], default: 'export', help: '默认 export：异步导出完整 CSV 后排序分页，避免长时间列表统计超时；list 显式使用旧列表接口' },
  { name: 'forceRefresh', type: 'bool', default: false, help: '远程 MCP export 强制重新导出；永久数据开启时使重叠覆盖失效，否则跳过 TTL 缓存。需使用新的 requestId，同一 ID 仍返回原任务。JS/stdio 无共享数据层' },
  { name: 'startDate', type: 'string', default: '', help: '开始时间，YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss（必填）' },
  { name: 'endDate', type: 'string', default: '', help: '结束时间，YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss（必填）' },
  { name: 'auctionSite', type: 'string', default: '', help: '品牌：EXR/eXtremeRate → JY；PV/PlayVital → YS；HEX/HexGaming → HX；OG/OstroGear → OG；留空查询全部品牌' },
  { name: 'auctionSiteType', type: 'string', default: '', help: '平台类型筛选；传给 ERP 的 auction_site_type' },
  { name: 'sku', type: 'string', default: '', help: '精确匹配 SKU；ERP 是前缀查询，脚本会抓取后再过滤' },
  { name: 'aggregateBy', type: 'string', choices: ['sku', 'sku-platform'], default: 'sku', help: '按 SKU 或 SKU+平台汇总' },
  { name: 'catalogId', type: 'string', default: '', help: '品牌类目 catalog_id；单个父类目自动展开，多个 ID 用逗号/空格分隔' },
  { name: 'productTypeCate', type: 'string', default: '5', help: '默认 5/顶级物料；传 6/二级物料，或显式空字符串查询全部类型' },
  { name: 'dateDimension', type: 'string', choices: ['monthly', 'yearly'], default: 'monthly', help: '统计维度' },
  { name: 'sort', type: 'string', choices: ['sales', 'mean', 'sku', 'name'], default: 'sales', help: '排序字段' },
  { name: 'order', type: 'string', choices: ['asc', 'desc'], default: 'desc', help: '排序方向' },
  { name: 'page', type: 'int', default: 1, help: '返回页码；export 下载完整 CSV 后本地分页，list 请求此页' },
  { name: 'pageSize', type: 'int', default: 20, help: '每页返回数量，1-100；Top N 用 page=1、pageSize=N、fetchAll=false，不传 sku' },
  { name: 'fetchAll', type: 'bool', default: false, help: 'true 返回全部排名；export 始终下载完整 CSV，false 仅截取结果页；list 全量时遍历分页；指定 sku 时精确过滤并返回全部匹配结果' },
  { name: 'maxPages', type: 'int', default: 100, help: '仅 list 模式抓取全部页时的最大页数，1-1000' },
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
  { name: 'raw', type: 'bool', default: false, help: '附带每行原始 JSON' },
];

async function main(argsValue) {
  const source = String(argsValue.source ?? 'export').trim();
  if (!['export', 'list'].includes(source)) throw new ArgumentError('source must be export or list');
  const start = normalizeDateTime(argsValue.startDate, 'startDate', false);
  const end = normalizeDateTime(argsValue.endDate, 'endDate', true);
  if (end.timestamp < start.timestamp) {
    throw new ArgumentError('endDate must be greater than or equal to startDate');
  }

  const sort = String(argsValue.sort ?? 'sales').trim().toLowerCase();
  if (!SORT_FIELDS.has(sort)) {
    throw new ArgumentError(`sort must be one of: ${[...SORT_FIELDS].join(', ')}`);
  }
  const order = String(argsValue.order ?? 'desc').trim().toLowerCase();
  if (!SORT_ORDERS.has(order)) {
    throw new ArgumentError(`order must be one of: ${[...SORT_ORDERS].join(', ')}`);
  }

  const auctionSite = normalizeAuctionSite(argsValue.auctionSite);
  const auctionSiteType = String(argsValue.auctionSiteType ?? '').trim();
  const sku = String(argsValue.sku ?? '').trim();
  const aggregateBy = String(argsValue.aggregateBy ?? 'sku').trim();
  if (!AGGREGATE_BY.has(aggregateBy)) throw new ArgumentError('aggregateBy must be sku or sku-platform');
  const dateDimension = String(argsValue.dateDimension ?? 'monthly').trim().toLowerCase();
  if (!DATE_DIMENSIONS.has(dateDimension)) {
    throw new ArgumentError(`dateDimension must be one of: ${[...DATE_DIMENSIONS].join(', ')}`);
  }
  const productTypeCate = normalizeProductTypeCate(argsValue.productTypeCate === undefined ? '5' : argsValue.productTypeCate);

  const page = positiveInteger(argsValue.page, 1, 'page', 100000);
  const pageSize = positiveInteger(argsValue.pageSize, 20, 'pageSize', 100);
  const fetchAll = Boolean(argsValue.fetchAll || sku);
  const maxPages = positiveInteger(argsValue.maxPages, 100, 'maxPages', 1000);
  if (source === 'list' && !fetchAll && (sort !== 'sales' || order !== 'desc')) {
    throw new ArgumentError(
      'single-page mode preserves the ERP native sales desc order; use --fetchAll true for other sort/order values',
    );
  }
  if (fetchAll && page !== 1) {
    throw new ArgumentError('page must be 1 when fetchAll=true');
  }
  const token = await resolveToken(argsValue);
  const catalogRows = argsValue.catalogId ? await fetchCatalogRows(token) : [];
  const catalogId = expandCatalogIds(argsValue.catalogId, catalogRows);
  const expectedCatalogNames = catalogNamesForIds(catalogId, catalogRows);
  if (source === 'export') {
    const { downloadSalesCsv } = require('./sales-volume-export.js');
    const { parseSalesCsv } = require('./sales-volume-csv.js');
    const query = { mode: 'sku', aggregate_by: aggregateBy, date_dimension: dateDimension,
      date_range: `${start.text} & ${end.text}`, index: 'sales-volume' };
    for (const [key, value] of Object.entries({ auction_site: auctionSite, auction_site_type: auctionSiteType,
      sku, catalog_id: catalogId, product_type_cate: productTypeCate })) {
      if (value) query[key] = value;
    }
    const exported = argsValue.loadExport
      ? await argsValue.loadExport({ token, query, start: start.text, end: end.text, onProgress: argsValue.onProgress })
      : await downloadSalesCsv({ token, query, start: start.text, end: end.text, onProgress: argsValue.onProgress });
    const { taskId } = exported;
    await argsValue.onProgress?.({ stage: 'parsing', taskId: String(taskId) });
    const allRows = exported.rows || parseSalesCsv(exported.file, { aggregateBy });
    if (sort === 'mean' && allRows.some((row) => row.mean === null)) {
      throw new CommandExecutionError('sales CSV is missing mean values required for mean sorting');
    }
    if (expectedCatalogNames?.size) {
      if (allRows.some((row) => !expectedCatalogNames.has(row.catalog_name_cn))) {
        throw new CommandExecutionError('sales CSV has missing or unexpected catalog names; cannot confirm catalog filter');
      }
    }
    const seen = new Set();
    checkDuplicateRows(allRows, seen, 'sales CSV', (row) => JSON.stringify([
      row.auction_site ?? '', row.sku, aggregateBy === 'sku-platform' ? row.auction_site_type : '',
    ]));
    const rows = sortRows(allRows.filter((row) => !sku || row.sku === sku), sort, order);
    const offset = fetchAll ? 0 : (page - 1) * pageSize;
    const selected = fetchAll ? rows : rows.slice(offset, offset + pageSize);
    if (!selected.length) throw new EmptyResultError('sales-volume-ranking', 'No SKU sales found in the requested CSV result page');
    return selected.map((row, index) => ({ ...outputRow(row, offset + index + 1, rows.length, Boolean(argsValue.raw)),
      source: 'export', taskId: String(taskId), ...(exported.parts ? { exportParts: exported.parts } : {}),
      ...(exported.cache ? { cache: exported.cache } : {}), ...(exported.localData ? { localData: exported.localData } : {}) }));
  }
  const firstPage = await fetchSalesPage({
    token,
    page,
    pageSize,
    startDateTime: start.text,
    endDateTime: end.text,
    auctionSite,
    auctionSiteType,
    sku,
    aggregateBy,
    dateDimension,
    catalogId,
    productTypeCate,
    expectedCatalogNames,
  });

  const totalCount = Number(firstPage.totalCount);
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    throw new CommandExecutionError(
      `new-erp sales-volume-ranking returned invalid totalCount: ${firstPage.totalCount}`,
    );
  }
  if (totalCount === 0) {
    throw new EmptyResultError(
      'new-erp sales-volume-ranking',
      `No SKU sales found from ${start.text} to ${end.text}; auctionSite=${auctionSite || '(all)'}, catalogId=${catalogId || '(all)'}`,
    );
  }

  const totalPages = Math.ceil(totalCount / pageSize);
  const seenRows = new Set();
  const rowKey = (row) => JSON.stringify([row.auction_site ?? '', row.sku,
    aggregateBy === 'sku-platform' ? row.auction_site_type ?? '' : '']);
  checkDuplicateRows(firstPage.list, seenRows, 'sales-volume-ranking', rowKey);
  if (!fetchAll) {
    if (firstPage.list.length === 0) {
      throw new EmptyResultError(
        'new-erp sales-volume-ranking',
        `Page ${page} is empty; totalCount=${totalCount}, totalPages=${totalPages}`,
      );
    }
    const rankOffset = (page - 1) * pageSize;
    return firstPage.list.map((apiRow, index) => outputRow(
      apiRow,
      rankOffset + index + 1,
      totalCount,
      Boolean(argsValue.raw),
    ));
  }

  if (totalPages > maxPages) {
    throw new ArgumentError(
      `query requires ${totalPages} pages (${totalCount} rows), exceeding maxPages=${maxPages}; narrow the filters/date range or increase maxPages`,
    );
  }

  const mergedRows = [...firstPage.list];
  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    const pageData = await fetchSalesPage({
      token,
      page: pageNumber,
      pageSize,
      startDateTime: start.text,
      endDateTime: end.text,
      auctionSite,
      auctionSiteType,
      sku,
      aggregateBy,
      dateDimension,
      catalogId,
      productTypeCate,
      expectedCatalogNames,
    });
    if (Number(pageData.totalCount) !== totalCount) {
      throw new CommandExecutionError(
        `new-erp sales-volume-ranking totalCount changed during pagination: ${totalCount} -> ${pageData.totalCount}`,
      );
    }
    if (pageData.list.length === 0) {
      throw new CommandExecutionError(
        `new-erp sales-volume-ranking page=${pageNumber} was empty before ${totalCount} rows were collected`,
      );
    }
    checkDuplicateRows(pageData.list, seenRows, 'sales-volume-ranking', rowKey);
    mergedRows.push(...pageData.list);
  }

  if (mergedRows.length !== totalCount) {
    throw new CommandExecutionError(
      `new-erp sales-volume-ranking merged ${mergedRows.length} rows but API reported totalCount=${totalCount}`,
    );
  }

  const sortedRows = sortRows(mergedRows.filter((apiRow) => !sku || String(apiRow?.sku ?? '').trim() === sku), sort, order);
  return sortedRows.map((row, index) => outputRow(row, index + 1, sortedRows.length, Boolean(argsValue.raw)));
}

function sortRows(rows, sort, order) {
  const decoratedRows = rows.map((apiRow, sourceIndex) => ({ apiRow, sourceIndex }));
  decoratedRows.sort((leftItem, rightItem) => {
    const primary = compareNullable(
      rawSortValue(leftItem.apiRow, sort),
      rawSortValue(rightItem.apiRow, sort),
      order,
    );
    if (primary !== 0) return primary;
    const skuTie = compareNullable(
      String(leftItem.apiRow?.sku ?? '').trim(),
      String(rightItem.apiRow?.sku ?? '').trim(),
      'asc',
    );
    return skuTie !== 0 ? skuTie : leftItem.sourceIndex - rightItem.sourceIndex;
  });

  return decoratedRows.map((item) => item.apiRow);
}

module.exports = {
  main,
  args,
  catalogNamesForIds,
  expandCatalogIds,
  fetchSalesPage,
  normalizeAuctionSite,
  normalizeDateTime,
  normalizeProductTypeCate,
  resolveToken,
};
