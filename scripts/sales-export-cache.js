const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonical, digest } = require('./mcp-job-store.js');
const { parseSalesCsv } = require('./sales-volume-csv.js');
const { monthLabels } = require('./sales-account-pool.js');

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const NAME = /^[a-f0-9]{64}\.json$/;

function normalizeCacheConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['enabled', 'ttlSeconds', 'maxBytes', 'maxEntries', 'epoch'].includes(key))) throw new Error('Invalid salesCache configuration');
  const config = { enabled: true, ttlSeconds: 900, maxBytes: 256 * 1024 * 1024, maxEntries: 256, epoch: '', ...value };
  if (typeof config.enabled !== 'boolean' || !Number.isInteger(config.ttlSeconds) || config.ttlSeconds < 1 || config.ttlSeconds > 86400
    || !Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1024 || config.maxBytes > 1024 * 1024 * 1024
    || !Number.isInteger(config.maxEntries) || config.maxEntries < 1 || config.maxEntries > 10000
    || typeof config.epoch !== 'string' || config.epoch.length > 200) throw new Error('Invalid salesCache configuration');
  return config;
}

function expectedPeriods(options) {
  const months = monthLabels(options.start, options.end);
  return options.query.date_dimension === 'yearly' ? [...new Set(months.map(month => month.slice(0, 4)))] : months;
}

function validateRows(rows, options) {
  if (!Array.isArray(rows)) throw new Error('Invalid cached sales rows');
  const expected = expectedPeriods(options), seen = new Set();
  for (const row of rows) {
    const id = canonical([row.auction_site || '', row.sku, options.query.aggregate_by === 'sku-platform' ? row.auction_site_type : '']);
    if (typeof row.sku !== 'string' || !row.sku || seen.has(id) || !Number.isFinite(row.sales_sum)
      || Math.abs(row.sales_sum) > Number.MAX_SAFE_INTEGER || (row.mean !== null && !Number.isFinite(row.mean))
      || !Array.isArray(row.statistics_rows) || row.statistics_rows.length !== expected.length) throw new Error('Invalid cached sales row');
    seen.add(id);
    const periods = new Set();
    let total = 0;
    for (const period of row.statistics_rows) {
      const label = String(period.date).replace(/^(\d{4})年(?:(\d{1,2})月)?$/, (_, year, month) => month ? `${year}-${month.padStart(2, '0')}` : year);
      if (!expected.includes(label) || periods.has(label) || !Number.isFinite(period.value) || Math.abs(period.value) > Number.MAX_SAFE_INTEGER) throw new Error('Invalid cached sales period');
      periods.add(label);
      total += period.value;
    }
    if (!Number.isFinite(total) || Math.abs(total) > Number.MAX_SAFE_INTEGER
      || Math.abs(total - row.sales_sum) > Number.EPSILON * Math.max(1, Math.abs(total), Math.abs(row.sales_sum)) * (expected.length + 1)) throw new Error('Invalid cached sales subtotal');
  }
}

function createSalesCache({ rootDir, config: value, now = Date.now }) {
  const config = normalizeCacheConfig(value);
  const directory = path.join(rootDir, '.sales-cache');
  let gate = Promise.resolve();
  async function initialize() {
    await fs.mkdir(directory, { mode: 0o700 });
  }
  async function checkDirectory() {
    try { await initialize(); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && stat.mode & 0o077)
      || await fs.realpath(directory) !== path.resolve(directory)) throw new Error('Unsafe sales cache directory');
  }
  async function read(filename) {
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES || (process.platform !== 'win32' && stat.mode & 0o077)) throw new Error('Unsafe sales cache file');
      const record = JSON.parse(await handle.readFile('utf8'));
      if (record.version !== 1 || record.key + '.json' !== path.basename(filename)
        || !Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt) || record.createdAt > now()
        || record.expiresAt <= record.createdAt || record.expiresAt - record.createdAt > 86400000
        || record.checksum !== digest(JSON.stringify(record.result))) throw new Error('Invalid sales cache record');
      return { record, size: stat.size };
    } finally { await handle.close(); }
  }
  async function prune(incoming = 0, incomingCount = 0) {
    const entries = [];
    for (const name of await fs.readdir(directory)) {
      if (!NAME.test(name)) continue;
      const filename = path.join(directory, name);
      try {
        const entry = await read(filename);
        if (entry.record.expiresAt <= now() || entry.record.createdAt + config.ttlSeconds * 1000 <= now()) throw new Error('Expired');
        entries.push({ ...entry, filename });
      } catch { await fs.unlink(filename).catch(() => {}); }
    }
    entries.sort((a, b) => a.record.createdAt - b.record.createdAt);
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    while (entries.length && (bytes + incoming > config.maxBytes || entries.length + incomingCount > config.maxEntries)) {
      const entry = entries.shift();
      await fs.unlink(entry.filename);
      bytes -= entry.size;
    }
  }
  function load(options, { identity, forceRefresh = false } = {}, download) {
    const run = async () => {
      if (!config.enabled) return download();
      await checkDirectory();
      await prune();
      const key = digest(canonical({ version: 1, identity, epoch: config.epoch, query: options.query, start: options.start, end: options.end }));
      const filename = path.join(directory, key + '.json');
      if (!forceRefresh) {
        try {
          const { record } = await read(filename);
          validateRows(record.result.rows, options);
          return { ...record.result, cache: { hit: true, fetchedAt: new Date(record.createdAt).toISOString(), expiresAt: new Date(Math.min(record.expiresAt, record.createdAt + config.ttlSeconds * 1000)).toISOString() } };
        } catch { await fs.unlink(filename).catch(() => {}); }
      } else {
        await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      const exported = await download();
      const rows = exported.rows || parseSalesCsv(exported.file, { aggregateBy: options.query.aggregate_by, expectedPeriods: expectedPeriods(options) });
      validateRows(rows, options);
      const result = { rows, taskId: String(exported.taskId), ...(exported.parts ? { parts: exported.parts } : {}) };
      const fetchedAt = now();
      const expiresAt = fetchedAt + config.ttlSeconds * 1000;
      const record = { version: 1, key, createdAt: fetchedAt, expiresAt, checksum: digest(JSON.stringify(result)), result };
      const json = JSON.stringify(record);
      const bytes = Buffer.byteLength(json);
      let stored = false;
      if (now() < expiresAt && bytes <= Math.min(MAX_ENTRY_BYTES, config.maxBytes)) {
        await prune(bytes, 1);
        const temporary = path.join(directory, `${crypto.randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, json, { mode: 0o600, flag: 'wx' });
          await fs.rename(temporary, filename);
          stored = true;
        } finally { await fs.unlink(temporary).catch(() => {}); }
      }
      return { ...result, cache: { hit: false, stored, fetchedAt: new Date(fetchedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() } };
    };
    const pending = gate.then(run);
    gate = pending.catch(() => {});
    return pending;
  }
  return { load };
}

module.exports = { createSalesCache, normalizeCacheConfig };
