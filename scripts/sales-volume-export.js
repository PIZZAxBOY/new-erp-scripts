const fs = require('node:fs/promises');
const path = require('node:path');
const {
  ArgumentError,
  CommandExecutionError,
  getBaseUrl,
  resolveToken,
  requestJson,
  redactSensitiveText,
  requiredString,
} = require('./shared.js');
const { normalizeDateTime } = require('./sales-volume-ranking.js');
const exportRoute = '/statistics/sales-volume/download-list';

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

async function tasks(token, timeoutMs = 120_000) {
  const json = await requestJson(urlFor('/settings/download-center/index', { page: 1, pageSize: 100 }), {
    label: 'new-erp download center', headers: { token }, timeoutMs,
  });
  if (!Array.isArray(json?.data?.list)) throw new CommandExecutionError('download center returned no list');
  return json.data.list;
}

function matchingTask(rows, query, start, end, previous = new Set()) {
  const matches = rows.filter((row) => {
    if (!row.id || previous.has(String(row.id)) || row.route_url !== exportRoute.slice(1)
      || row.start_date !== start || row.end_date !== end) return false;
    try {
      const params = JSON.parse(row.add_condition).params;
      return Object.entries(query).every(([key, value]) => String(params[key] ?? '') === String(value))
        && Object.entries(params).every(([key, value]) => key in query || value === null || value === undefined || value === '');
    } catch { return false; }
  });
  if (matches.length > 1) throw new CommandExecutionError('sales export has multiple matching new tasks');
  return matches[0];
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
  const token = await resolveToken(options);
  const query = {
    mode: aggregateBy === 'platform' ? 'domain' : 'sku',
    aggregate_by: aggregateBy,
    date_dimension: 'monthly',
    date_range: `${start.text} & ${end.text}`,
    index: 'sales-volume',
  };
  if (options.auctionSiteType) query.auction_site_type = String(options.auctionSiteType).trim();
  const exported = options.loadExport
    ? await options.loadExport({ token, query, start: start.text, end: end.text, onProgress: options.onProgress })
    : await downloadSalesCsv({ token, query, start: start.text, end: end.text, onProgress: options.onProgress });
  const merged = Buffer.isBuffer(exported.file) ? null : serializeSalesCsv(
    exported.rows, aggregateBy, require('./sales-account-pool.js').monthLabels(start.text, end.text));
  const file = merged || exported.file;
  if (!Buffer.isBuffer(file)) throw new CommandExecutionError('sales export did not return a CSV');
  await fs.writeFile(output, file, { flag: 'wx', mode: 0o600 });
  return [{
    taskId: String(exported.taskId), output, bytes: file.length,
    encoding: merged ? 'UTF-8' : 'GBK', ...(exported.parts ? { parts: exported.parts } : {}),
  }];
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeSalesCsv(rows, aggregate, periods) {
  if (!Array.isArray(rows) || !Array.isArray(periods)) throw new CommandExecutionError('sales export merge did not produce rows');
  const headers = [
    ...(aggregate === 'platform' ? [] : ['sku']),
    ...(aggregate === 'sku' ? [] : ['平台']),
    '小计',
    ...periods,
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    if (!Array.isArray(row.statistics_rows) || row.statistics_rows.length !== periods.length
      || row.statistics_rows.some((period, index) => period.date !== periods[index])) {
      throw new CommandExecutionError('sales export merge periods do not match');
    }
    lines.push([
      ...(aggregate === 'platform' ? [] : [row.sku]),
      ...(aggregate === 'sku' ? [] : [row.auction_site_type]),
      row.sales_sum,
      ...row.statistics_rows.map(period => period.value),
    ].map(csvCell).join(','));
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

async function downloadSalesCsv({ token, query, start, end, onProgress, beforeSubmit }) {
  const progress = async (stage, task) => onProgress?.({ stage, taskId: task ? String(task.id) : '', status: String(task?.status ?? '') });
  const deadline = Date.now() + 20 * 60 * 1000;
  await progress('submitting');
  const previous = new Set((await tasks(token)).map((row) => String(row.id)));
  await beforeSubmit?.();
  let submitError;
  try {
    const submitted = await requestJson(urlFor(exportRoute, query), {
      label: 'new-erp sales export', headers: { token },
      timeoutMs: Math.max(1, Math.min(120_000, deadline - Date.now())),
    });
    if (/已存在下载任务|请勿重复/.test(String(submitted?.msg || submitted?.data?.msg || ''))) {
      throw Object.assign(new CommandExecutionError('ERP already has a running export; no new task was created'), { code: 'EXPORT_BUSY' });
    }
  } catch (error) { if (error.code === 'EXPORT_BUSY') throw error; submitError = error; }
  let task;
  for (let attempt = 0; attempt < 10 && Date.now() < deadline; attempt += 1) {
    task = matchingTask(await tasks(token, Math.max(1, Math.min(120_000, deadline - Date.now()))), query, start, end, previous);
    if (task) break;
    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(0, deadline - Date.now()))));
  }
  if (!task) throw submitError || new CommandExecutionError('sales export task was not found in download center');
  while (String(task.status) !== '3') {
    if (String(task.status) === '4') throw new CommandExecutionError(`sales export task ${task.id} failed: ${redactSensitiveText(task.error_reason || 'unknown reason', [token])}`);
    if (Date.now() >= deadline) throw new CommandExecutionError(`sales export task ${task.id} still pending after 20 minutes`);
    await progress('waiting', task);
    await new Promise((resolve) => setTimeout(resolve, Math.min(15000, Math.max(0, deadline - Date.now()))));
    if (Date.now() >= deadline) throw new CommandExecutionError(`sales export task ${task.id} still pending after 20 minutes`);
    task = (await tasks(token, Math.max(1, Math.min(120_000, deadline - Date.now()))))
      .find((row) => String(row.id) === String(task.id));
    if (!task) throw new CommandExecutionError('sales export task disappeared from download center');
  }
  if (Date.now() >= deadline) throw new CommandExecutionError(`sales export task ${task.id} exceeded 20 minutes`);
  await progress('downloading', task);
  const response = await fetch(urlFor('/settings/download-center/download-file', { id: task.id }), {
    headers: { token }, redirect: 'error', signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !/attachment/i.test(response.headers.get('content-disposition') || '')) {
    throw new CommandExecutionError(`sales export task ${task.id} did not return a CSV attachment: HTTP ${response.status}`);
  }
  const maxBytes = 64 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new CommandExecutionError('sales export CSV exceeds 64 MiB; narrow the query');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new CommandExecutionError('sales export CSV exceeds 64 MiB; narrow the query');
    chunks.push(chunk);
  }
  return { taskId: task.id, file: Buffer.concat(chunks), fileIdentity: task.down_file || null };
}

module.exports = { main, matchingTask, downloadSalesCsv, serializeSalesCsv, args };
