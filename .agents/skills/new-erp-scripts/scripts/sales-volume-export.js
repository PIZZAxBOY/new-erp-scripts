#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
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
  { name: 'startDate', type: 'string', default: '', help: '开始日期或时间（必填）' },
  { name: 'endDate', type: 'string', default: '', help: '结束日期或时间（必填）' },
  { name: 'aggregateBy', type: 'string', choices: ['sku', 'sku-platform', 'platform'], default: 'sku', help: '汇总维度；platform 自动使用 mode=domain' },
  { name: 'auctionSiteType', type: 'string', default: '', help: '平台类型筛选' },
  { name: 'output', type: 'string', default: '', help: '保存 CSV 的文件路径（必填，不能覆盖已有文件）' },
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
];

function urlFor(route, params = {}) {
  const url = new URL(`${getBaseUrl()}/index.php`);
  url.searchParams.set('r', route);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

async function tasks(token) {
  const json = await requestJson(urlFor('/settings/download-center/index', { page: 1, pageSize: 100 }), {
    label: 'new-erp download center', headers: { token },
  });
  if (!Array.isArray(json?.data?.list)) throw new CommandExecutionError('download center returned no list');
  return json.data.list;
}

function matchingTask(rows, query, start, end) {
  return rows.find((row) => {
    if (row.start_date !== start || row.end_date !== end) return false;
    try {
      const params = JSON.parse(row.add_condition).params;
      return Object.entries(query).every(([key, value]) => String(params[key] ?? '') === String(value));
    } catch { return false; }
  });
}

async function main(options) {
  const start = normalizeDateTime(options.startDate, 'startDate', false);
  const end = normalizeDateTime(options.endDate, 'endDate', true);
  if (end.timestamp < start.timestamp) throw new ArgumentError('endDate must be greater than or equal to startDate');
  const aggregateBy = String(options.aggregateBy ?? 'sku').trim();
  if (!['sku', 'sku-platform', 'platform'].includes(aggregateBy)) throw new ArgumentError('invalid aggregateBy');
  const output = path.resolve(requiredString(options.output, 'output'));
  try {
    await fs.access(output);
    throw new ArgumentError(`output already exists: ${output}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = getTokenFromArgs(options) || (await loginToken(options)).token;
  const query = {
    mode: aggregateBy === 'platform' ? 'domain' : 'sku',
    aggregate_by: aggregateBy,
    date_dimension: 'monthly',
    date_range: `${start.text} & ${end.text}`,
    index: 'sales-volume',
  };
  if (options.auctionSiteType) query.auction_site_type = String(options.auctionSiteType).trim();
  let task = matchingTask(await tasks(token), query, start.text, end.text);
  if (!task) {
    let submitError;
    try {
      await requestJson(urlFor('/statistics/sales-volume/download-list', query), {
        label: 'new-erp sales export', headers: { token },
      });
    } catch (error) { submitError = error; }
    for (let attempt = 0; attempt < 10 && !task; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      task = matchingTask(await tasks(token), query, start.text, end.text);
    }
    if (!task) throw submitError || new CommandExecutionError('sales export task was not found in download center');
  }
  const deadline = Date.now() + 20 * 60 * 1000;
  while (String(task.status) !== '3') {
    if (String(task.status) === '4') throw new CommandExecutionError(`sales export task ${task.id} failed: ${task.error_reason || 'unknown reason'}`);
    if (Date.now() > deadline) throw new CommandExecutionError(`sales export task ${task.id} still pending after 20 minutes`);
    await new Promise((resolve) => setTimeout(resolve, 15000));
    task = (await tasks(token)).find((row) => row.id === task.id);
    if (!task) throw new CommandExecutionError('sales export task disappeared from download center');
  }
  const response = await fetch(urlFor('/settings/download-center/download-file', { id: task.id }), {
    headers: { token }, signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !/attachment/i.test(response.headers.get('content-disposition') || '')) {
    throw new CommandExecutionError(`sales export task ${task.id} did not return a CSV attachment: HTTP ${response.status}`);
  }
  const file = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(output, file, { flag: 'wx', mode: 0o600 });
  return [{ taskId: task.id, output, bytes: file.length, encoding: 'GBK' }];
}

module.exports = { main, matchingTask };

if (require.main === module) {
  runCli({ name: 'sales-volume-export', description: '异步导出 SKU、SKU+平台或平台月销量 CSV。', args, func: main });
}
