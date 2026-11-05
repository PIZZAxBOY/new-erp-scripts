const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { canonical, digest } = require('./mcp-job-store.js');
const { normalizeDateTime } = require('./sales-volume-ranking.js');
const { monthLabels } = require('./sales-account-pool.js');
const { parseSalesCsv } = require('./sales-volume-csv.js');
const { expectedPeriods, validateRows } = require('./sales-export-cache.js');

const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const MAX_BYTES = 64 * 1024 * 1024;
const META = /^[a-f0-9-]{36}\.json$/;
const HASH = /^[a-f0-9]{64}$/;
const format = value => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
const label = value => String(value).replace(/^(\d{4})年(?:(\d{1,2})月)?$/, (_, y, m) => m ? `${y}-${m.padStart(2, '0')}` : y);
const overlaps = (a, b) => a.from < b.until && b.from < a.until;

function range(options) {
  const from = normalizeDateTime(options.start, 'startDate', false).timestamp;
  const until = normalizeDateTime(options.end, 'endDate', true).timestamp + 1000;
  if (until <= from || until - from > 36600 * 86400000) throw new Error('Invalid permanent sales range');
  return { from, until };
}

function normalizeDataConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['enabled', 'maxBytes', 'minFreeBytes', 'epoch'].includes(key))) throw new Error('Invalid salesData configuration');
  const config = { enabled: true, maxBytes: 10 * 1024 ** 3, minFreeBytes: 1024 ** 3, epoch: '', ...value };
  if (typeof config.enabled !== 'boolean' || !Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1024
    || !Number.isSafeInteger(config.minFreeBytes) || config.minFreeBytes < 0 || typeof config.epoch !== 'string'
    || config.epoch.length > 200) throw new Error('Invalid salesData configuration');
  return config;
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && stat.mode & 0o077)
    || await fs.realpath(directory) !== path.resolve(directory)) throw new Error('Unsafe permanent sales directory');
}

async function readPrivate(filename, maxBytes) {
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes || (process.platform !== 'win32' && stat.mode & 0o077)) throw new Error('Unsafe permanent sales file');
    return await file.readFile();
  } finally { await file.close(); }
}

async function writePrivate(filename, buffer) {
  const file = await fs.open(filename, 'wx', 0o600);
  try { await file.writeFile(buffer); await file.sync(); } finally { await file.close(); }
}

function rowKey(row, aggregate = 'sku') {
  if (aggregate === 'platform') return row.auction_site_type || '';
  if (aggregate === 'sku-platform') return `${row.sku || ''}\0${row.auction_site_type || ''}`;
  return row.sku || '';
}

function reusable(rows, aggregate = 'sku') {
  return new Set(rows.map(row => rowKey(row, aggregate))).size === rows.length && rows.every(row => Number.isSafeInteger(row.sales_sum)
    && row.sales_sum > 0 && row.statistics_rows.every(p => Number.isSafeInteger(p.value) && p.value >= 0));
}

function monthWindows(options) {
  const span = range(options);
  if (options.query.date_dimension !== 'monthly') return [{ ...span, month: null }];
  const months = monthLabels(options.start, options.end);
  if (months.length <= 1) return [{ ...span, month: months[0] || null }];
  return months.map(month => {
    const start = Date.parse(`${month}-01T00:00:00Z`);
    const next = new Date(start);
    const until = Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1);
    return { month, from: Math.max(span.from, start), until: Math.min(span.until, until) };
  }).filter(window => window.from < window.until);
}

function monthSlice(options, rows, window) {
  if (!window.month || monthWindows(options).length <= 1) return { options, rows };
  const start = format(window.from), end = format(window.until - 1000);
  const sliceRows = rows.flatMap(row => {
    const value = row.statistics_rows.find(period => label(period.date) === window.month)?.value;
    if (!Number.isSafeInteger(value) || value === 0) return [];
    return [{ ...row, mean: null, sales_sum: value, statistics_rows: [{ date: window.month, value }] }];
  });
  return {
    options: {
      ...options, start, end,
      query: { ...options.query, date_dimension: 'monthly', date_range: `${start} & ${end}` },
    },
    rows: sliceRows,
  };
}

function fragments(records, wanted) {
  const result = [];
  records.forEach((record, index) => {
    if (!record.reusable) return;
    for (const month of monthLabels(format(record.from), format(record.until - 1000))) {
      const date = new Date(month + '-01T00:00:00Z');
      const part = { from: Math.max(record.from, date.getTime()),
        until: Math.min(record.until, Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)), month, record };
      if (part.from < wanted.from || part.until > wanted.until) continue;
      if (records.slice(index + 1).some(newer => overlaps(part, newer))) continue;
      result.push(part);
    }
  });
  return result.sort((a, b) => a.from - b.from);
}

function gaps(parts, wanted) {
  const missing = [];
  let cursor = wanted.from;
  for (const part of parts) {
    if (part.from < cursor) throw new Error('Overlapping permanent sales fragments');
    if (part.from > cursor) missing.push({ from: cursor, until: part.from });
    cursor = part.until;
  }
  if (cursor < wanted.until) missing.push({ from: cursor, until: wanted.until });
  return missing;
}

function assemble(parts, bodies, options) {
  const aggregate = options.query.aggregate_by || 'sku';
  const months = monthLabels(options.start, options.end), totals = new Map();
  for (const part of parts) {
    for (const row of bodies.get(part.record.id).rows) {
      const value = row.statistics_rows.find(p => label(p.date) === part.month)?.value;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Cannot assemble signed or ambiguous sales data');
      if (!value) continue;
      const key = rowKey(row, aggregate);
      if (!totals.has(key)) totals.set(key, { row, periods: new Map() });
      const periods = totals.get(key).periods, sum = (periods.get(part.month) || 0) + value;
      if (!Number.isSafeInteger(sum)) throw new Error('Unsafe assembled sales total');
      periods.set(part.month, sum);
    }
  }
  const rows = [...totals.values()].map(({ row, periods }) => {
    const values = new Map();
    for (const month of months) {
      const key = options.query.date_dimension === 'yearly' ? month.slice(0, 4) : month;
      values.set(key, (values.get(key) || 0) + (periods.get(month) || 0));
    }
    return { ...row, sku: row.sku, auction_site: row.auction_site || options.query.auction_site || null,
      sales_sum: [...values.values()].reduce((a, b) => a + b, 0), mean: null,
      statistics_rows: [...values].map(([date, value]) => ({ date, value })) };
  });
  validateRows(rows, options);
  return rows;
}

function createSalesDataStore({ rootDir, config: value, now = Date.now }) {
  const config = normalizeDataConfig(value), root = path.join(rootDir, '.sales-data');
  let gate = Promise.resolve();
  async function capacity(incoming) {
    let bytes = 0;
    for (const name of await fs.readdir(root)) {
      if (!HASH.test(name)) continue;
      const directory = path.join(root, name);
      await privateDirectory(directory);
      for (const file of await fs.readdir(directory)) {
        const stat = await fs.lstat(path.join(directory, file));
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe permanent sales entry');
        bytes += stat.size;
      }
    }
    const disk = await fs.statfs(root);
    if (bytes + incoming > config.maxBytes || disk.bavail * disk.bsize - incoming < config.minFreeBytes) {
      throw Object.assign(new Error('Permanent sales storage capacity reached; historical snapshots retained. Administrator action required.'), { code: 'STORAGE_FULL' });
    }
  }
  async function index(directory, family) {
    const records = [];
    for (const file of await fs.readdir(directory)) {
      if (!META.test(file)) continue;
      const record = JSON.parse((await readPrivate(path.join(directory, file), 64 * 1024)).toString('utf8'));
      if (record.version !== 1 || record.family !== family || record.id + '.json' !== file || !HASH.test(record.checksum)
        || !Number.isSafeInteger(record.from) || !Number.isSafeInteger(record.until) || record.until <= record.from
        || !Number.isFinite(record.fetchedAt) || !Number.isSafeInteger(record.sequence) || record.sequence < 1
        || typeof record.reusable !== 'boolean') throw new Error('Invalid permanent sales index');
      records.push(record);
    }
    return records.sort((a, b) => a.sequence - b.sequence);
  }
  async function body(directory, record) {
    const compressed = await readPrivate(path.join(directory, record.id + '.json.gz'), MAX_BYTES + 1024 * 1024);
    const raw = await gunzip(compressed, { maxOutputLength: MAX_BYTES });
    if (digest(raw) !== record.checksum) throw new Error('Permanent sales snapshot checksum mismatch');
    const saved = JSON.parse(raw.toString('utf8'));
    if (saved.family !== record.family || saved.from !== record.from || saved.until !== record.until
      || saved.fetchedAt !== record.fetchedAt || saved.reusable !== record.reusable
      || saved.sequence !== record.sequence) throw new Error('Permanent sales index does not match snapshot');
    validateRows(saved.result.rows, saved.options);
    if (record.reusable && !reusable(saved.result.rows, saved.options.query.aggregate_by)) throw new Error('Invalid reusable sales snapshot');
    return saved.result;
  }
  async function persist(directory, family, options, exported, allowRange, sequence) {
    const fetchedAt = exported.fetchedAt ?? now();
    if (!Number.isFinite(fetchedAt) || fetchedAt > now()) throw new Error('Invalid export download time');
    const rows = exported.rows || parseSalesCsv(exported.file, { aggregateBy: options.query.aggregate_by, expectedPeriods: expectedPeriods(options) });
    validateRows(rows, options);
    const result = { rows, taskId: String(exported.taskId), taskIds: exported.taskIds || [String(exported.taskId)], ...(exported.parts ? { parts: exported.parts } : {}) };
    const base = { version: 1, family, ...range(options), fetchedAt, sequence,
      reusable: Boolean(allowRange && options.query.date_dimension === 'monthly' && reusable(rows, options.query.aggregate_by)) };
    const raw = Buffer.from(JSON.stringify({ ...base, options: { start: options.start, end: options.end, query: options.query }, result }));
    if (raw.length > MAX_BYTES) throw new Error('Permanent sales snapshot exceeds 64 MiB; no data was deleted');
    const compressed = await gzip(raw);
    const record = { ...base, id: crypto.randomUUID(), checksum: digest(raw) };
    const meta = JSON.stringify(record), blob = path.join(directory, record.id + '.json.gz'), temp = path.join(directory, record.id + '.tmp');
    await capacity(compressed.length + Buffer.byteLength(meta));
    let published = false;
    try {
      await writePrivate(blob, compressed); await writePrivate(temp, meta);
      await fs.rename(temp, path.join(directory, record.id + '.json')); published = true;
    } finally {
      await fs.unlink(temp).catch(() => {});
      if (!published) await fs.unlink(blob).catch(() => {});
    }
    return { record, result };
  }
  function metadata(result, records, mode, hit) {
    const times = records.map(r => r.fetchedAt);
    return { ...result, cache: { hit, permanent: true }, localData: { mode, snapshots: records.map(r => r.id),
      oldestFetchedAt: new Date(Math.min(...times)).toISOString(), newestFetchedAt: new Date(Math.max(...times)).toISOString(),
      ...(mode === 'assembled' || mode === 'mixed' ? { skuPolicy: 'positive-sales', mean: 'unavailable' } : {}) } };
  }
  function load(options, { identity, allowRangeReuse = false, forceRefresh = false } = {}, download) {
    allowRangeReuse = Boolean(allowRangeReuse) && ['monthly', 'yearly'].includes(options.query.date_dimension || 'monthly');
    const run = async () => {
      if (!config.enabled) return download(options);
      const wanted = range(options), query = { ...options.query };
      delete query.date_range;
      if (allowRangeReuse) delete query.date_dimension;
      const family = digest(canonical({ version: 1, identity, query, allowRangeReuse, epoch: config.epoch }));
      const directory = path.join(root, family);
      await privateDirectory(root); await privateDirectory(directory);
      let records = await index(directory, family);
      const exact = records.findLast((r, i) => !r.invalidated && r.from === wanted.from && r.until === wanted.until
        && !records.slice(i + 1).some(newer => overlaps(r, newer)));
      if (!forceRefresh && exact) {
        const result = await body(directory, exact);
        validateRows(result.rows, options); return metadata(result, [exact], 'exact', true);
      }
      if (forceRefresh) {
        const invalidation = { version: 1, family, ...wanted, fetchedAt: now(), sequence: (records.at(-1)?.sequence || 0) + 1,
          reusable: false, invalidated: true, id: crypto.randomUUID(), checksum: digest('') };
        const temp = path.join(directory, invalidation.id + '.tmp'), json = JSON.stringify(invalidation);
        await capacity(Buffer.byteLength(json));
        try { await writePrivate(temp, json); await fs.rename(temp, path.join(directory, invalidation.id + '.json')); }
        finally { await fs.unlink(temp).catch(() => {}); }
        records.push(invalidation);
      }
      const fetchRange = async interval => {
        await capacity(1024);
        const start = format(interval.from), end = format(interval.until - 1000);
        const request = { ...options, start, end, query: { ...options.query, date_range: `${start} & ${end}`,
          date_dimension: allowRangeReuse ? 'monthly' : options.query.date_dimension } };
        const exported = await download(request);
        const rows = exported.rows || parseSalesCsv(exported.file, {
          aggregateBy: request.query.aggregate_by, expectedPeriods: expectedPeriods(request),
        });
        const saved = [];
        for (const slice of monthWindows(request).map(window => monthSlice(request, rows, window))) {
          const record = await persist(directory, family, slice.options, { ...exported, rows: slice.rows, file: undefined },
            allowRangeReuse, (records.at(-1)?.sequence || 0) + 1);
          records.push(record.record);
          saved.push(record.record);
        }
        return { result: { rows, taskId: String(exported.taskId), taskIds: exported.taskIds || [String(exported.taskId)],
          ...(exported.parts ? { parts: exported.parts } : {}) }, records: saved };
      };
      if (forceRefresh || !allowRangeReuse) {
        const saved = await fetchRange(wanted);
        return metadata(saved.result, saved.records, 'export', false);
      }
      let parts = fragments(records, wanted);
      let missing = gaps(parts, wanted);
      const hadLocal = parts.length > 0;
      if (missing.length > 32) missing = [wanted];
      if (missing.length === 1 && missing[0].from === wanted.from && missing[0].until === wanted.until) {
        const saved = await fetchRange(wanted);
        return metadata(saved.result, saved.records, 'export', false);
      }
      for (const interval of missing) await fetchRange(interval);
      const complete = records.findLast((r, i) => !r.invalidated && r.from === wanted.from && r.until === wanted.until
        && !records.slice(i + 1).some(newer => overlaps(r, newer)));
      if (complete && options.query.date_dimension === 'monthly') {
        return metadata(await body(directory, complete), [complete], missing.length ? 'export' : 'exact', missing.length === 0);
      }
      parts = fragments(records, wanted);
      if (gaps(parts, wanted).length) {
        const saved = await fetchRange(wanted);
        return metadata(saved.result, saved.records, 'export', false);
      }
      const selected = [...new Map(parts.map(p => [p.record.id, p.record])).values()], bodies = new Map();
      for (const record of selected) bodies.set(record.id, await body(directory, record));
      if (gaps(parts, wanted).length) throw new Error('Incomplete permanent sales coverage');
      const rows = assemble(parts, bodies, options), first = bodies.values().next().value;
      return metadata({ rows, taskId: first.taskId, taskIds: selected.flatMap(r => bodies.get(r.id).taskIds),
        parts: selected.reduce((sum, r) => sum + (bodies.get(r.id).parts || 1), 0) }, selected,
      missing.length ? (hadLocal ? 'mixed' : 'export') : 'assembled', missing.length === 0);
    };
    const pending = gate.then(run); gate = pending.catch(() => {}); return pending;
  }
  return { load };
}

module.exports = { createSalesDataStore, normalizeDataConfig };
