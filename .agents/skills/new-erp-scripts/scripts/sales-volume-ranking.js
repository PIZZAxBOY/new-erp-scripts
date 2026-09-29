#!/usr/bin/env node
const {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  catalogNamesForIds,
  expandCatalogIds,
  fetchCatalogRows,
  getBaseUrl,
  getTokenFromArgs,
  loginToken,
  positiveInteger,
  requestJson,
  requiredString,
  runCli,
} = require('./shared.js');

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
    throw new ArgumentError('productTypeCate must be 5/顶级物料 or 6/二级物料; omit it to query all product types');
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
    imageUrl: String(row?.full_image_url ?? row?.image_url ?? '').trim() || null,
    rawJson: includeRaw ? JSON.stringify(row) : null,
  };
}

async function resolveToken(args) {
  const existingToken = getTokenFromArgs(args);
  if (existingToken) return existingToken;
  const session = await loginToken(args);
  return session.token;
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
  { name: 'startDate', type: 'string', default: '', help: '开始时间，YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss（必填）' },
  { name: 'endDate', type: 'string', default: '', help: '结束时间，YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss（必填）' },
  { name: 'auctionSite', type: 'string', default: '', help: '品牌：EXR/eXtremeRate → JY；PV/PlayVital → YS；HEX/HexGaming → HX；OG/OstroGear → OG；留空查询全部品牌' },
  { name: 'auctionSiteType', type: 'string', default: '', help: '平台类型筛选；传给 ERP 的 auction_site_type' },
  { name: 'sku', type: 'string', default: '', help: '精确匹配 SKU；ERP 是前缀查询，脚本会抓取后再过滤' },
  { name: 'aggregateBy', type: 'string', choices: ['sku', 'sku-platform'], default: 'sku', help: '按 SKU 或 SKU+平台汇总' },
  { name: 'catalogId', type: 'string', default: '', help: '品牌类目 catalog_id；单个父类目自动展开，多个 ID 用逗号/空格分隔' },
  { name: 'productTypeCate', type: 'string', default: '', help: '产品类型：5/顶级物料，6/二级物料；留空不筛选' },
  { name: 'dateDimension', type: 'string', choices: ['monthly', 'yearly'], default: 'monthly', help: '统计维度' },
  { name: 'sort', type: 'string', choices: ['sales', 'mean', 'sku', 'name'], default: 'sales', help: '排序字段' },
  { name: 'order', type: 'string', choices: ['asc', 'desc'], default: 'desc', help: '排序方向' },
  { name: 'page', type: 'int', default: 1, help: '页码；默认只请求这一页' },
  { name: 'pageSize', type: 'int', default: 20, help: '每页返回数量，1-100' },
  { name: 'fetchAll', type: 'bool', default: false, help: '抓取全部页并做全局排序' },
  { name: 'maxPages', type: 'int', default: 100, help: '抓取全部页时的最大页数，1-1000' },
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
  { name: 'raw', type: 'bool', default: false, help: '附带每行原始 JSON' },
];

async function main(argsValue) {
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
  const productTypeCate = normalizeProductTypeCate(argsValue.productTypeCate);

  const page = positiveInteger(argsValue.page, 1, 'page', 100000);
  const pageSize = positiveInteger(argsValue.pageSize, 20, 'pageSize', 100);
  const fetchAll = Boolean(argsValue.fetchAll || sku);
  const maxPages = positiveInteger(argsValue.maxPages, 100, 'maxPages', 1000);
  if (!fetchAll && (sort !== 'sales' || order !== 'desc')) {
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
    mergedRows.push(...pageData.list);
  }

  if (mergedRows.length !== totalCount) {
    throw new CommandExecutionError(
      `new-erp sales-volume-ranking merged ${mergedRows.length} rows but API reported totalCount=${totalCount}`,
    );
  }

  const decoratedRows = mergedRows
    .filter((apiRow) => !sku || String(apiRow?.sku ?? '').trim() === sku)
    .map((apiRow, sourceIndex) => ({ apiRow, sourceIndex }));
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

  return decoratedRows.map((item, index) => outputRow(
    item.apiRow,
    index + 1,
    decoratedRows.length,
    Boolean(argsValue.raw),
  ));
}

module.exports = {
  main,
  catalogNamesForIds,
  expandCatalogIds,
  fetchSalesPage,
  normalizeAuctionSite,
  normalizeDateTime,
  normalizeProductTypeCate,
  resolveToken,
};

if (require.main === module) {
  runCli({
    name: 'sales-volume-ranking',
    description: '查询 new-erp SKU 销量排行。',
    args,
    func: main,
  });
}
