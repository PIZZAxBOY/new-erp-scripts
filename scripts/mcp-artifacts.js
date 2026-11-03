const fs = require('node:fs/promises');
const path = require('node:path');

const JSON_BUDGET = 10000;
const PREVIEW_BUDGET = 2200;
const isPrimitive = value => value === null || ['string', 'boolean', 'number'].includes(typeof value);
const clipped = (value, bytes) => Buffer.from(value).subarray(0, bytes).toString('utf8');

class StreamFailure extends Error {
  constructor(partialResult, cause) {
    super('Page stream did not finish.', { cause });
    this.partialResult = partialResult;
  }
}

function preview(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.list) ? value.list : [value];
  const list = [];
  for (const row of rows.slice(0, 3)) {
    const fields = [];
    function visit(item, prefix = '', depth = 0) {
      if (!item || typeof item !== 'object' || depth > 3) return;
      for (const [key, val] of Object.entries(item)) {
        const name = prefix ? `${prefix}.${key}` : key;
        if (/^rawJson$/i.test(key)) continue;
        if (isPrimitive(val)) fields.push([name, typeof val === 'string' && !/(?:url|asin|sku)$/i.test(key) ? clipped(val, 180) : val]);
        else if (!Array.isArray(val)) visit(val, name, depth + 1);
      }
    }
    if (isPrimitive(row)) fields.push(['value', typeof row === 'string' ? clipped(row, 180) : row]);
    else visit(row);
    const identity = [];
    for (const pattern of [/(^|\.)asin$/i, /(^|\.)sku$/i, /(^|\.)image.?url$/i]) {
      const field = fields.find(([key]) => pattern.test(key));
      if (field) identity.push(field);
    }
    const ordered = [...identity, ...fields.filter(field => !identity.includes(field))];
    const item = {};
    for (const [key, val] of ordered) {
      item[key] = val;
      if (Buffer.byteLength(JSON.stringify([...list, item])) > PREVIEW_BUDGET) delete item[key];
    }
    if (Object.keys(item).length) list.push(item);
  }
  return list;
}

async function metadata(file, mediaType, extra = {}) {
  const stat = await fs.stat(file);
  await fs.chmod(file, 0o600);
  return { path: file, mediaType, bytes: stat.size, complete: true, ...extra };
}

async function exclusive(file, value, mediaType, extra) {
  await fs.writeFile(file, value, { flag: 'wx', mode: 0o600 });
  return metadata(file, mediaType, extra);
}

async function adaptResult(value, { dir, outputPath }) {
  if (Buffer.isBuffer(value) || Buffer.isBuffer(value?.file)) {
    const buffer = Buffer.isBuffer(value) ? value : value.file;
    const artifact = await exclusive(path.join(dir, 'export.xlsx'), buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return { artifact, ...(typeof value?.taskId === 'string' ? { taskId: value.taskId } : {}), ...(Number.isFinite(value?.boxes) ? { boxes: value.boxes } : {}) };
  }
  const output = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (output?.output && output.output === outputPath) {
    const artifact = await metadata(outputPath, outputPath.endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return { artifact, ...(typeof output.taskId === 'string' ? { taskId: output.taskId } : {}), ...(Number.isFinite(output.boxes) ? { boxes: output.boxes } : {}), ...(output.encoding ? { encoding: output.encoding } : {}) };
  }
  const data = Array.isArray(value) ? { list: value } : value;
  const json = JSON.stringify(data ?? null);
  if (Buffer.byteLength(json) <= JSON_BUDGET) return { data: data ?? null };
  const artifact = await exclusive(path.join(dir, 'result.json'), json, 'application/json');
  const result = { artifact, preview: preview(data) };
  if (Array.isArray(data?.list)) result.rowCount = data.list.length;
  for (const field of ['page', 'pageSize', 'totalCount', 'fetchedCount', 'complete']) {
    if (isPrimitive(data?.[field]) && data[field] !== undefined) result[field] = data[field];
  }
  return result;
}

async function consumePages(iterator, { dir, active }) {
  const file = path.join(dir, 'pages.ndjson');
  const handle = await fs.open(file, 'wx', 0o600);
  let pageCount = 0; let rowCount = 0; let last = {};
  let error;
  try {
    for await (const page of iterator) {
      if (!active()) throw new Error('Job stopped');
      await handle.writeFile(`${JSON.stringify(page)}\n`);
      pageCount += 1;
      rowCount += Array.isArray(page?.list) ? page.list.length : 0;
      last = page;
    }
  } catch (cause) { error = cause; }
  finally { await handle.close(); }
  const artifact = await metadata(file, 'application/x-ndjson', { complete: !error, pageCount, rowCount });
  const result = { artifact, pageCount, rowCount };
  for (const field of ['page', 'pageSize', 'totalCount', 'fetchedCount', 'complete']) {
    if (isPrimitive(last?.[field]) && last[field] !== undefined) result[field] = last[field];
  }
  if (error) { delete result.complete; throw new StreamFailure(result, error); }
  return result;
}

module.exports = { adaptResult, consumePages, StreamFailure };
