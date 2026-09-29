#!/usr/bin/env node
const {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  HOST,
  positiveInteger,
  runCli,
} = require('./shared.js');
const {
  catalogNamesForIds,
  expandCatalogIds,
  fetchCatalogRows,
  fetchSalesPage,
  normalizeAuctionSite,
  normalizeDateTime,
  normalizeProductTypeCate,
  resolveToken,
} = require('./sales-volume-ranking.js');

const args = [
  { name: 'startDate', type: 'string', default: '', help: '开始时间，YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss（必填）' },
  { name: 'endDate', type: 'string', default: '', help: '结束时间，YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss（必填）' },
  { name: 'auctionSite', type: 'string', default: '', help: '品牌：EXR/eXtremeRate → JY；PV/PlayVital → YS；HEX/HexGaming → HX；OG/OstroGear → OG；留空查询全部品牌' },
  { name: 'catalogId', type: 'string', default: '', help: '类目 ID；单个父类目自动展开，多个 ID 用逗号/空格分隔' },
  { name: 'productTypeCate', type: 'string', default: '', help: '产品类型：5/顶级物料或 6/二级物料；留空查询全部' },
  { name: 'dateDimension', type: 'string', choices: ['monthly', 'yearly'], default: 'monthly', help: '统计维度' },
  { name: 'pageSize', type: 'int', default: 100, help: '每页 SKU 销量行数，1-100' },
  { name: 'maxPages', type: 'int', default: 100, help: '最大抓取页数，1-1000' },
  { name: 'concurrency', type: 'int', default: 1, help: '第 1 页后分页请求并发数，1-10' },
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
];

async function main(argsValue) {
  const start = normalizeDateTime(argsValue.startDate, 'startDate', false);
  const end = normalizeDateTime(argsValue.endDate, 'endDate', true);
  if (end.timestamp < start.timestamp) {
    throw new ArgumentError('endDate must be greater than or equal to startDate');
  }

  const auctionSite = normalizeAuctionSite(argsValue.auctionSite);
  const dateDimension = String(argsValue.dateDimension ?? 'monthly').trim().toLowerCase();
  if (!['monthly', 'yearly'].includes(dateDimension)) {
    throw new ArgumentError('dateDimension must be one of: monthly, yearly');
  }
  const productTypeCate = normalizeProductTypeCate(argsValue.productTypeCate);
  const pageSize = positiveInteger(argsValue.pageSize, 100, 'pageSize', 100);
  const maxPages = positiveInteger(argsValue.maxPages, 100, 'maxPages', 1000);
  const concurrency = positiveInteger(argsValue.concurrency, 1, 'concurrency', 10);
  const token = await resolveToken(argsValue);
  const catalogRows = argsValue.catalogId ? await fetchCatalogRows(token) : [];
  const catalogId = expandCatalogIds(argsValue.catalogId, catalogRows);
  const expectedCatalogNames = catalogNamesForIds(catalogId, catalogRows);

  const fetchPage = (page) => fetchSalesPage({
    token,
    page,
    pageSize,
    startDateTime: start.text,
    endDateTime: end.text,
    auctionSite,
    dateDimension,
    catalogId,
    productTypeCate,
    expectedCatalogNames,
    commandName: 'category-summary',
  });
  const firstPage = await fetchPage(1);
  const totalCount = Number(firstPage.totalCount);
  if (!Number.isInteger(totalCount) || totalCount < 0) {
    throw new CommandExecutionError(`new-erp category-summary returned invalid totalCount: ${firstPage.totalCount}`);
  }
  if (totalCount === 0) {
    throw new EmptyResultError(
      'new-erp category-summary',
      `No SKU sales found from ${start.text} to ${end.text}; auctionSite=${auctionSite || '(all)'}, catalogId=${catalogId || '(all)'}`,
    );
  }
  if (firstPage.list.length === 0) {
    throw new CommandExecutionError(
      `new-erp category-summary page=1 was empty before ${totalCount} SKU sales rows were collected`,
    );
  }

  const totalPages = Math.ceil(totalCount / pageSize);
  if (totalPages > maxPages) {
    throw new ArgumentError(
      `exhaustive category count requires ${totalPages} pages (${totalCount} SKU sales rows), exceeding maxPages=${maxPages}; narrow the filters/date range or increase maxPages`,
    );
  }

  const rows = [...firstPage.list];
  for (let page = 2; page <= totalPages; page += concurrency) {
    const pages = Array.from(
      { length: Math.min(concurrency, totalPages - page + 1) },
      (_, index) => page + index,
    );
    const pageResults = await Promise.all(pages.map(async (pageNumber) => [pageNumber, await fetchPage(pageNumber)]));
    for (const [pageNumber, pageData] of pageResults) {
      if (Number(pageData.totalCount) !== totalCount) {
        throw new CommandExecutionError(
          `new-erp category-summary totalCount changed during exhaustive pagination: ${totalCount} -> ${pageData.totalCount}`,
        );
      }
      if (pageData.list.length === 0) {
        throw new CommandExecutionError(
          `new-erp category-summary page=${pageNumber} was empty before ${totalCount} SKU sales rows were collected`,
        );
      }
      rows.push(...pageData.list);
    }
  }
  if (rows.length !== totalCount) {
    throw new CommandExecutionError(
      `new-erp category-summary fetched ${rows.length} SKU sales rows but API reported totalCount=${totalCount}`,
    );
  }

  const counts = new Map();
  const seenSkuRows = new Set();
  for (const row of rows) {
    const sku = String(row?.sku ?? '').trim();
    if (!sku) throw new CommandExecutionError('new-erp category-summary returned a SKU sales row without sku');
    const rowSite = String(row?.auction_site ?? '').trim();
    if (auctionSite && rowSite !== auctionSite) {
      throw new CommandExecutionError(
        `new-erp category-summary auction_site filter mismatch: expected ${auctionSite}, got ${rowSite || '(empty)'}`,
      );
    }
    const rowKey = `${rowSite}\u0000${sku}`;
    if (seenSkuRows.has(rowKey)) {
      throw new CommandExecutionError(
        `new-erp category-summary found a duplicate SKU sales row for auctionSite=${rowSite || '(empty)'}, sku=${sku}`,
      );
    }
    seenSkuRows.add(rowKey);
    const categoryName = String(row?.catalog_name_cn ?? '').trim() || '(未分类)';
    counts.set(categoryName, (counts.get(categoryName) ?? 0) + 1);
  }

  const distinctCategoryCount = counts.size;
  return [...counts]
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName, 'zh-CN'))
    .map(([categoryNameCn, skuSalesRowCount]) => ({
      categoryNameCn,
      skuSalesRowCount,
      scope: 'complete',
      fetchedSkuSalesRowCount: rows.length,
      totalSkuSalesRowCount: totalCount,
      fetchedPageCount: totalPages,
      distinctCategoryCount,
    }));
}

module.exports = { main };

if (require.main === module) {
  runCli({
    name: 'category-summary',
    description: '完整抓取并按 ERP 类目统计 SKU 销量行数。',
    args,
    func: main,
  });
}
