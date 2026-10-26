#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { ArgumentError, CommandExecutionError, positiveInteger, redactSensitiveText, resolveToken, requestJson, requiredString, runCli } = require('./shared.js');
const { main: packingOrderList, args: listArgs, packingQuery, historyQuery, urlFor } = require('./packing-order-list.js');
const { queryPages, selectionValue } = require('./query.js');

const route = '/warehouse/packing-order/down-packing-detail';
const args = [
  ...listArgs.filter((arg) => !['page', 'pageSize', 'fetchAll', 'maxPages'].includes(arg.name)),
  { name: 'output', type: 'string', default: '', help: '保存原生 XLSX 的路径（CLI必填，不覆盖已有文件）' },
  { name: 'pollMs', type: 'int', default: 3000, help: '下载任务轮询间隔，毫秒' },
  { name: 'timeoutMs', type: 'int', default: 1200000, help: '等待下载任务完成的时限，毫秒' },
  { name: 'taskId', type: 'string', help: '显式恢复匹配查询的下载任务；不创建新任务' },
];

async function main(options = {}) {
  const query = { ...packingQuery(options), ...historyQuery(options) };
  const pollMs = positiveInteger(options.pollMs, 3000, 'pollMs');
  const timeoutMs = positiveInteger(options.timeoutMs, 20 * 60_000, 'timeoutMs');
  const resumeId = options.taskId === undefined ? null : selectionValue(options.taskId, 'taskId');
  const output = options.output ? path.resolve(requiredString(options.output, 'output')) : null;
  if (output) {
    try {
      await fs.access(output);
      throw new ArgumentError(`output already exists: ${output}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const token = await resolveToken(options);
  const listing = await packingOrderList({ ...options, token, page: 1, pageSize: 20, fetchAll: false });
  const boxes = listing.totalCount;
  if (!boxes && !resumeId) return { taskId: '', query, boxes: 0, ...(output ? { output: null, bytes: 0 } : { file: null }) };
  const tasks = async (timeoutMs = 120_000) => {
    const { data } = await requestJson(urlFor('/settings/download-center/index', { page: 1, pageSize: 100 }), {
      headers: { token }, label: 'ERP 下载中心', timeoutMs,
    });
    if (!Array.isArray(data?.list)) throw new CommandExecutionError('ERP download center returned no task list');
    return data.list;
  };
  const previous = new Set();
  if (!resumeId) {
    for (const row of await tasks()) previous.add(String(row.id));
    await requestJson(urlFor(route, query), { headers: { token }, label: 'ERP 装箱明细导出' });
  }
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    if (Date.now() >= deadline) throw new CommandExecutionError(`ERP packing export timed out after ${timeoutMs}ms`);
    return Math.max(1, Math.min(120_000, deadline - Date.now()));
  };
  const matchesQuery = (row) => {
    if (row.route_url !== route.slice(1)) return false;
    try {
      const condition = JSON.parse(row.add_condition);
      return Object.entries(query).every(([key, value]) => condition[key] === value)
        && Object.entries(condition).every(([key, value]) => key in query || value === null || value === '');
    } catch { return false; }
  };
  const findOlderTask = async (id) => {
    const paging = { token, pageSize: 100, fetchAll: true, maxPages: 1000, timeoutMs: remaining() };
    for await (const page of queryPages('/settings/download-center/index', {}, paging)) {
      remaining();
      const match = page.list.find((row) => String(row.id) === id);
      if (match) return match;
      paging.timeoutMs = remaining();
    }
    return null;
  };
  let task;
  let taskId = resumeId;
  let reported = false;
  while (Date.now() < deadline) {
    const rows = await tasks(Math.max(1, Math.min(120_000, deadline - Date.now())));
    if (taskId) {
      task = rows.find((row) => String(row.id) === taskId) || await findOlderTask(taskId);
      if (!task) throw new CommandExecutionError('ERP packing export task disappeared from download center');
      if (!matchesQuery(task)) throw new CommandExecutionError('ERP packing export task does not match the requested query or route');
    } else {
      const matches = rows.filter((row) => {
        return row.id && !previous.has(String(row.id)) && matchesQuery(row);
      });
      if (matches.length > 1) throw new CommandExecutionError('ERP packing export has multiple matching new tasks');
      task = matches[0];
      if (task) taskId = String(task.id);
    }
    if (task && !reported) {
      await options.onProgress?.({ stage: 'waiting', boxes, taskId });
      reported = true;
    }
    if (Date.now() >= deadline) throw new CommandExecutionError(`ERP packing export timed out after ${timeoutMs}ms`);
    if (String(task?.status) === '3') break;
    if (String(task?.status) === '4') throw new CommandExecutionError(`ERP packing export task ${task.id} failed: ${redactSensitiveText(task.error_reason || 'unknown reason', [token])}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  if (String(task?.status) !== '3') throw new CommandExecutionError(`ERP packing export timed out after ${timeoutMs}ms`);
  await options.onProgress?.({ stage: 'download', boxes, taskId: String(task.id) });
  const response = await fetch(urlFor('/settings/download-center/download-file', { id: task.id }), {
    headers: { token }, redirect: 'error', signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !/attachment/i.test(response.headers.get('content-disposition') || '')) {
    throw new CommandExecutionError(`ERP packing export download failed: HTTP ${response.status}`);
  }
  const file = Buffer.from(await response.arrayBuffer());
  if (file.subarray(0, 2).toString() !== 'PK') throw new CommandExecutionError('ERP packing export is not an XLSX file');
  if (output) await fs.writeFile(output, file, { flag: 'wx', mode: 0o600 });
  return { taskId: String(task.id), query, boxes, ...(output ? { output, bytes: file.length } : { file }) };
}

module.exports = { main };
if (require.main === module) {
  runCli({ name: 'packing-detail-export', description: '按扫描出库日期原生导出装箱明细 XLSX，等待任务完成后下载；空结果不创建文件。', args,
    func: (options) => main({ ...options, output: requiredString(options.output, 'output') }) });
}
