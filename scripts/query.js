const {
  ArgumentError, CommandExecutionError, getBaseUrl, resolveToken, positiveInteger, requestJson,
} = require('./shared.js');

const authArgs = [
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
];
const listArgs = [
  { name: 'page', type: 'int', default: 1, help: '页码' },
  { name: 'pageSize', type: 'int', default: 20, help: '每页数量，1–100' },
  { name: 'fetchAll', type: 'bool', default: false, help: '抓取全部分页，必须从第1页开始' },
  { name: 'maxPages', type: 'int', default: 100, help: '最多分页数，1–1000' },
  ...authArgs,
];

function enumValue(value, fallback, choices, label) {
  const text = String(value ?? fallback);
  if (!choices.includes(text)) throw new ArgumentError(`${label} must be one of: ${choices.join(', ')}`);
  return text;
}

function selectionValue(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new ArgumentError(`${label} must be a non-empty ERP code without whitespace or wildcards`);
  }
  return value;
}

async function queryData(route, query, options = {}) {
  const token = await resolveToken(options);
  const url = new URL(`${getBaseUrl()}/index.php`);
  url.searchParams.set('r', route);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const { data } = await requestJson(url.href, { headers: { token }, label: route, timeoutMs: options.timeoutMs });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CommandExecutionError(`${route} returned invalid data`);
  }
  return { data, source: { route, query, fetchedAt: new Date().toISOString() } };
}

function validatePage(data, page, pageSize, route) {
  const count = Number(data?.totalCount);
  if (data?.totalCount === null || data?.totalCount === undefined || String(data.totalCount).trim() === ''
    || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(data.list)
    || data.list.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
    || (data.page !== undefined && Number(data.page) !== page)
    || (data.pageSize !== undefined && Number(data.pageSize) !== pageSize)
    || data.list.length !== Math.min(pageSize, Math.max(0, count - (page - 1) * pageSize))) {
    throw new CommandExecutionError(`${route} returned invalid or incomplete pagination data`);
  }
  return count;
}

function checkDuplicateRows(rows, seen, label, rowKey = (row) =>
  row.id === null || row.id === undefined || row.id === '' ? JSON.stringify(row) : String(row.id)) {
  for (const row of rows) {
    const key = rowKey(row);
    if (seen.has(key)) throw new CommandExecutionError(`${label} returned a duplicate record during pagination`);
    seen.add(key);
  }
}

async function* queryPages(route, query, options = {}, rowKey) {
  const page = positiveInteger(options.page, 1, 'page');
  const pageSize = positiveInteger(options.pageSize, 20, 'pageSize', 100);
  const maxPages = positiveInteger(options.maxPages, 100, 'maxPages', 1000);
  if (options.fetchAll !== undefined && typeof options.fetchAll !== 'boolean') {
    throw new ArgumentError('fetchAll must be true or false');
  }
  if (options.fetchAll && page !== 1) throw new ArgumentError('page must be 1 when fetchAll=true');
  const token = await resolveToken(options);
  let total;
  let fetchedCount = 0;
  const seen = new Set();
  for (let current = page; ; current += 1) {
    const result = await queryData(route, { ...query, page: current, pageSize }, { ...options, token });
    const { data } = result;
    const count = validatePage(data, current, pageSize, route);
    if (total === undefined) {
      total = count;
      if (options.fetchAll && Math.ceil(total / pageSize) > maxPages) {
        throw new ArgumentError(`${route} requires ${Math.ceil(total / pageSize)} pages, exceeding maxPages=${maxPages}`);
      }
    } else if (count !== total) throw new CommandExecutionError(`${route} totalCount changed during pagination`);
    checkDuplicateRows(data.list, seen, route, rowKey);
    fetchedCount += data.list.length;
    yield { ...data, page: current, pageSize, totalCount: total, fetchedCount,
      complete: current * pageSize >= total, source: result.source };
    if (!options.fetchAll || current * pageSize >= total) break;
  }
}

async function queryList(route, query, options = {}, rowKey) {
  let first;
  const rows = [];
  for await (const result of queryPages(route, query, options, rowKey)) {
    first ??= result;
    rows.push(...result.list);
  }
  return { ...first, list: rows, fetchedCount: rows.length,
    complete: first.page === 1 && rows.length === first.totalCount };
}

module.exports = { authArgs, listArgs, enumValue, selectionValue, queryData, queryList, queryPages, validatePage, checkDuplicateRows };
