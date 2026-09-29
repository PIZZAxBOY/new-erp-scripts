#!/usr/bin/env node
const {
  ArgumentError,
  CommandExecutionError,
  getBaseUrl,
  getTokenFromArgs,
  loginToken,
  requestJson,
  requiredString,
  runCli,
} = require('./shared.js');
const { normalizeDateTime } = require('./sales-volume-ranking.js');

const args = [
  { name: 'sku', type: 'string', default: '', help: '精确匹配的 SKU' },
  { name: 'startDate', type: 'string', default: '', help: '入库开始日期 YYYY-MM-DD' },
  { name: 'endDate', type: 'string', default: '', help: '入库结束日期 YYYY-MM-DD' },
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
];

async function fetchRows(token, route, params) {
  const rows = [];
  let total;
  for (let page = 1; page <= 1000; page += 1) {
    const url = new URL(`${getBaseUrl()}/index.php`);
    url.searchParams.set('r', route);
    for (const [key, value] of Object.entries({ ...params, page, pageSize: 100 })) {
      url.searchParams.set(key, String(value));
    }
    const { data } = await requestJson(url.href, { headers: { token }, label: route });
    if (!Array.isArray(data?.list) || !Number.isInteger(Number(data?.totalCount))) {
      throw new CommandExecutionError(`${route} returned invalid pagination data`);
    }
    if (total === undefined) total = Number(data.totalCount);
    if (Number(data.totalCount) !== total) throw new CommandExecutionError(`${route} totalCount changed during pagination`);
    rows.push(...data.list);
    if (rows.length >= total) return rows;
    if (!data.list.length) throw new CommandExecutionError(`${route} page ${page} was empty before all rows were fetched`);
  }
  throw new CommandExecutionError(`${route} exceeded 1000 pages`);
}

function summarize(sku, inventory, tasks) {
  const byOrder = new Map(tasks
    .filter((row) => row.sku === sku && String(row.type) === '2')
    .map((row) => [String(row.pz_no || row.confirmed_no), row]));
  const records = inventory.flatMap((row) => {
    const task = byOrder.get(String(row.purchase_orderid || ''));
    if (row.sku !== sku || row.action_name !== '入库'
      || !String(row.in_out_remark || '').startsWith('拼装物料组合SKU:') || !task) return [];
    const quantity = Number(row.put_num);
    if (!Number.isFinite(quantity) || quantity < 0) throw new CommandExecutionError(`invalid put_num on inventory row ${row.id}`);
    return [{ inventoryId: row.id, taskId: task.id, orderNo: row.purchase_orderid,
      actionTime: row.action_time, stockCode: row.stock_code, quantity }];
  });
  return { quantity: records.reduce((sum, row) => sum + row.quantity, 0), records };
}

async function main(options) {
  const sku = requiredString(options.sku, 'sku');
  const start = normalizeDateTime(options.startDate, 'startDate', false);
  const end = normalizeDateTime(options.endDate, 'endDate', true);
  if (end.timestamp < start.timestamp) throw new ArgumentError('endDate must be greater than or equal to startDate');
  const token = getTokenFromArgs(options) || (await loginToken(options)).token;
  const inventory = await fetchRows(token, '/warehouse/inventory/product-in-out-record', {
    sku, sku_type: 1, action_time: `${start.text} & ${end.text}`,
  });
  const candidates = inventory.filter((row) => row.sku === sku && row.action_name === '入库'
    && String(row.in_out_remark || '').startsWith('拼装物料组合SKU:'));
  const tasks = candidates.length
    ? await fetchRows(token, '/warehouse/produce-task/wait-assemble-list', { sku, type: 2 })
    : [];
  return { sku, startDate: start.text, endDate: end.text, metric: '备货拼装实际入库',
    ...summarize(sku, candidates, tasks) };
}

module.exports = { main, summarize };

if (require.main === module) {
  runCli({ name: 'stocking-assembly-inbound', description: '按 SKU 和入库日期统计备货拼装的实际入库数量。', args, func: main });
}
