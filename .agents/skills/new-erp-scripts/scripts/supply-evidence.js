#!/usr/bin/env node
const {
  ArgumentError,
  CommandExecutionError,
  getBaseUrl,
  getTokenFromArgs,
  loginToken,
  positiveInteger,
  requestJson,
  requiredString,
  runCli,
} = require('./shared.js');
const { normalizeDateTime } = require('./sales-volume-ranking.js');

const SOURCES = {
  plan: '/warehouse/sales-plan-order/list',
  move: '/sales/move-plan-order/list',
  inventory: '/warehouse/inventory/product-in-out-record',
  assembly: '/procurement/plan-assembly/index',
  cargo: '/warehouse/cargo-flow/list',
};

const args = [
  { name: 'source', type: 'string', choices: Object.keys(SOURCES), default: '', help: '单据来源：plan 销售计划、move 搬运计划、inventory 成品出入库、assembly 组装计划、cargo 货物流转' },
  { name: 'sku', type: 'string', default: '', help: '精确匹配的 SKU（必填）' },
  { name: 'startDate', type: 'string', default: '', help: '开始日期；仅 plan/move/inventory 支持，须与 endDate 同时填写' },
  { name: 'endDate', type: 'string', default: '', help: '结束日期；仅 plan/move/inventory 支持，须与 startDate 同时填写' },
  { name: 'page', type: 'int', default: 1, help: '页码' },
  { name: 'pageSize', type: 'int', default: 20, help: '每页记录数，1-100' },
  { name: 'fetchAll', type: 'bool', default: false, help: '抓取所有页，最多 maxPages 页' },
  { name: 'maxPages', type: 'int', default: 100, help: '最多抓取页数，1-1000' },
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
];

async function api(token, route, params) {
  const url = new URL(`${getBaseUrl()}/index.php`);
  url.searchParams.set('r', route);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const json = await requestJson(url.href, { label: `new-erp ${route}`, headers: { token } });
  return json.data;
}

async function main(options) {
  const source = String(options.source ?? '').trim();
  if (!SOURCES[source]) throw new ArgumentError(`source must be one of: ${Object.keys(SOURCES).join(', ')}`);
  const sku = requiredString(options.sku, 'sku');
  const hasStart = Boolean(options.startDate);
  const hasEnd = Boolean(options.endDate);
  if (hasStart !== hasEnd) throw new ArgumentError('startDate and endDate must be supplied together');
  if (hasStart && !['plan', 'move', 'inventory'].includes(source)) {
    throw new ArgumentError(`${source} does not support a reliable date filter`);
  }
  let start;
  let end;
  if (hasStart) {
    start = normalizeDateTime(options.startDate, 'startDate', false);
    end = normalizeDateTime(options.endDate, 'endDate', true);
    if (end.timestamp < start.timestamp) throw new ArgumentError('endDate must be greater than or equal to startDate');
  }
  const page = positiveInteger(options.page, 1, 'page', 100000);
  const pageSize = positiveInteger(options.pageSize, 20, 'pageSize', 100);
  const maxPages = positiveInteger(options.maxPages, 100, 'maxPages', 1000);
  if (options.fetchAll && page !== 1) throw new ArgumentError('page must be 1 when fetchAll=true');
  const token = getTokenFromArgs(options) || (await loginToken(options)).token;
  const query = { sku, pageSize };
  if (start) {
    const range = `${start.text} & ${end.text}`;
    if (source === 'plan' || source === 'move') query.add_time = range;
    if (source === 'inventory') {
      query.sku_type = 1;
      query.action_time = range;
    }
  } else if (source === 'inventory') query.sku_type = 1;

  const rows = [];
  let totalCount;
  for (let current = page; ; current += 1) {
    const data = await api(token, SOURCES[source], { ...query, page: current });
    if (!Array.isArray(data?.list)) throw new CommandExecutionError(`${source} returned no list`);
    const count = Number(data.totalCount);
    if (!Number.isInteger(count) || count < 0) throw new CommandExecutionError(`${source} returned invalid totalCount`);
    if (totalCount === undefined) {
      totalCount = count;
      if (options.fetchAll && Math.ceil(count / pageSize) > maxPages) {
        throw new ArgumentError(`${source} requires ${Math.ceil(count / pageSize)} pages, exceeding maxPages=${maxPages}`);
      }
    } else if (count !== totalCount) throw new CommandExecutionError(`${source} totalCount changed during pagination`);
    if (options.fetchAll && current <= Math.ceil(totalCount / pageSize) && !data.list.length) {
      throw new CommandExecutionError(`${source} page ${current} was empty before all rows were fetched`);
    }
    rows.push(...data.list);
    if (!options.fetchAll || current >= Math.ceil(totalCount / pageSize)) break;
  }

  if (source === 'plan' || source === 'move') {
    const details = [];
    for (const row of rows) {
      if (row.id == null || !row.confirmed_no) throw new CommandExecutionError('plan row missing id or confirmed_no');
      const detail = await api(token, '/warehouse/sales-plan-order/view-detail', { id: row.id, confirmed_no: row.confirmed_no });
      if (!Array.isArray(detail?.data)) throw new CommandExecutionError(`plan ${row.confirmed_no} returned no detail data`);
      for (const item of detail.data.filter((item) => String(item?.sku ?? '').trim() === sku)) {
        details.push({ source, orderId: row.id, confirmedNo: row.confirmed_no, addTime: row.add_time, sku,
          plannedNum: item.num, detail: item });
      }
    }
    return details;
  }
  if (source === 'cargo') return rows.filter((row) => String(row?.product_info?.sku ?? '').trim() === sku);
  return rows.filter((row) => String(row?.sku ?? '').trim() === sku);
}

module.exports = { main };

if (require.main === module) {
  runCli({ name: 'supply-evidence', description: '按 SKU 查询销售计划、成品出入库及备货候选单据。', args, func: main });
}
