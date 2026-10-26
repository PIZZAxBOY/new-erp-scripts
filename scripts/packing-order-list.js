#!/usr/bin/env node
const {
  ArgumentError, CommandExecutionError, getBaseUrl, requiredString, runCli,
} = require('./shared.js');
const { normalizeDateTime } = require('./sales-volume-ranking.js');
const { listArgs, queryList, queryPages, selectionValue } = require('./query.js');

const args = [
  { name: 'project', type: 'string', help: 'ERP 项目代码，从 ERP 枚举获取；历史范围查询必填' },
  { name: 'warehouses', type: 'string', help: '完整目的仓名称，逗号分隔；历史范围查询必填' },
  { name: 'startDate', type: 'string', help: '扫描出库开始日期或时间；历史范围查询必填' },
  { name: 'endDate', type: 'string', help: '扫描出库结束日期或时间；历史范围查询必填' },
  { name: 'packingNo', type: 'string', help: '精确总单号；可独立查询，或收窄历史范围' },
  { name: 'stockFrom', type: 'string', help: '发货仓代码，仅作为收窄条件' },
  { name: 'status', type: 'string', default: '', help: 'ERP 状态筛选，空白表示全部状态' },
  ...listArgs,
];

function packingQuery(options) {
  const query = {};
  if (options.packingNo !== undefined) {
    query.number_field = 'packing_num';
    query.number_value = selectionValue(options.packingNo, 'packingNo');
  }
  if (options.stockFrom !== undefined) query.stock_from = selectionValue(options.stockFrom, 'stockFrom');
  const hasHistory = ['project', 'warehouses', 'startDate', 'endDate'].some((key) => options[key] !== undefined);
  if (!query.number_value || hasHistory) Object.assign(query, historyQuery(options));
  else query.status = String(options.status ?? '');
  return query;
}

function historyQuery(options) {
  const project = requiredString(options.project, 'project');
  const start = normalizeDateTime(options.startDate, 'startDate', false);
  const end = normalizeDateTime(options.endDate, 'endDate', true);
  if (end.timestamp < start.timestamp) throw new ArgumentError('endDate must be greater than or equal to startDate');
  const warehouses = Array.isArray(options.warehouses)
    ? options.warehouses : typeof options.warehouses === 'string' ? options.warehouses.split(',') : [];
  if (!warehouses.length || warehouses.some((v) => typeof v !== 'string' || !v || /[,;\s]/.test(v))
    || new Set(warehouses).size !== warehouses.length) {
    throw new ArgumentError('warehouses must contain unique complete warehouse names without whitespace');
  }
  return { auction_site: project, site_type: warehouses.join(','), status: String(options.status ?? ''),
    time_type: 'out_time', scan_date: `${start.text} & ${end.text}` };
}

function urlFor(route, params = {}) {
  const url = new URL(`${getBaseUrl()}/index.php`);
  url.searchParams.set('r', route);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.href;
}

async function main(options = {}) {
  const query = packingQuery(options);
  return { ...await queryList('/warehouse/packing-order/list', query, options, rowKey(query)), query };
}

function rowKey(query) {
  return (row) => {
    if ((query.site_type && !query.site_type.split(',').includes(row.site_type))
      || (query.stock_from && row.stock_from !== query.stock_from)
      || (query.number_value && row.packing_num !== query.number_value)) {
      throw new CommandExecutionError('ERP packing list contains a warehouse or packing number outside the requested selection');
    }
    const key = row.packing_num_no ?? row.id;
    if (key === undefined || key === null || String(key).trim() === '') {
      throw new CommandExecutionError('ERP packing list returned a record without a box number or id');
    }
    return String(key);
  };
}

async function* pages(options = {}) {
  if (options.fetchAll !== undefined && options.fetchAll !== true) {
    throw new ArgumentError('packingOrderPages always reads all pages; omit fetchAll or use true');
  }
  const query = packingQuery(options);
  for await (const result of queryPages('/warehouse/packing-order/list', query, { ...options, fetchAll: true }, rowKey(query))) {
    yield { ...result, query };
  }
}

module.exports = { main, pages, args, packingQuery, historyQuery, urlFor };
if (require.main === module) {
  runCli({ name: 'packing-order-list', description: '按总单号或完整历史范围查询装箱列表；支持 fetchAll，逐页消费使用 packing-order-pages。', args, func: main });
}
