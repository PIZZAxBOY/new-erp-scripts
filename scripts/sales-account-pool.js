const { withErpContext, CommandExecutionError } = require('./shared.js');
const { normalizeDateTime } = require('./sales-volume-ranking.js');
const { parseSalesCsv } = require('./sales-volume-csv.js');

function invalid(message) {
  return new CommandExecutionError(`Account pool: ${message}`);
}

function normalizeParallelExports(value = 3) {
  if (!Number.isInteger(value) || value < 1 || value > 32) throw invalid('maxParallelExports must be an integer from 1 to 32');
  return value;
}

const format = timestamp => new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');

function normalizeSingleAccountDays(value = 31) {
  if (!Number.isInteger(value) || value < 1 || value > 366) throw invalid('singleAccountDays must be an integer from 1 to 366');
  return value;
}

function splitMonths(start, end, count, singleAccountDays = 31) {
  normalizeSingleAccountDays(singleAccountDays);
  const from = normalizeDateTime(start, 'startDate', false).timestamp;
  const to = normalizeDateTime(end, 'endDate', true).timestamp;
  if (to < from || !Number.isSafeInteger(count) || count < 1) throw invalid('invalid split range or account count');
  const first = new Date(from), last = new Date(to);
  const months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1;
  if (months > 1200) throw invalid('date range exceeds 100 years');
  const duration = to + 1000 - from;
  const minimum = 14 * 86400000;
  const candidates = [];
  for (let i = 1; i < months; i++) {
    const boundary = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1);
    if (boundary - from >= minimum && to + 1000 - boundary >= minimum) candidates.push(boundary);
  }
  const size = duration <= singleAccountDays * 86400000 ? 1 : Math.min(count, candidates.length + 1);
  const boundaries = [from];
  let next = 0;
  for (let i = 1; i < size; i++) {
    const target = from + duration * i / size;
    const last = candidates.length - (size - i);
    let chosen = next;
    for (let j = next + 1; j <= last; j++) {
      if (Math.abs(candidates[j] - target) < Math.abs(candidates[chosen] - target)) chosen = j;
    }
    boundaries.push(candidates[chosen]);
    next = chosen + 1;
  }
  boundaries.push(to + 1000);
  return Array.from({ length: size }, (_, i) => ({
    start: format(boundaries[i]),
    end: format(boundaries[i + 1] - 1000),
  }));
}

function monthLabels(start, end) {
  const from = new Date(start.slice(0, 10) + 'T00:00:00Z');
  const until = end.slice(0, 7);
  const labels = [];
  let value = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1);
  while (new Date(value).toISOString().slice(0, 7) <= until) {
    labels.push(new Date(value).toISOString().slice(0, 7));
    const d = new Date(value);
    value = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return labels;
}

function monthLabel(value) {
  const match = /^(\d{4})(?:-(\d{2})|年(\d{1,2})月)$/.exec(value);
  if (!match) throw invalid('CSV must contain monthly period columns');
  const month = Number(match[2] || match[3]);
  if (month < 1 || month > 12) throw invalid('invalid monthly period');
  return `${match[1]}-${String(month).padStart(2, '0')}`;
}

function add(a, b) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a + b)) {
    throw invalid('non-integer or unsafe sales total');
  }
  return a + b;
}

function rowIdentity(row, aggregate) {
  if (aggregate === 'platform') {
    if (!row.auction_site_type) throw invalid('missing or duplicate platform within a segment');
    return row.auction_site_type;
  }
  if (aggregate === 'sku-platform') {
    if (!row.sku || !row.auction_site_type) throw invalid('missing or duplicate SKU within a segment');
    return `${row.sku}\0${row.auction_site_type}`;
  }
  if (!row.sku) throw invalid('missing or duplicate SKU within a segment');
  return row.sku;
}

function mergeParts(parts, dimension, aggregate = 'sku') {
  const merged = new Map(), covered = new Set();
  for (const part of parts) {
    const expected = monthLabels(part.start, part.end);
    for (const month of expected) {
      if (covered.has(month)) throw invalid('overlapping split periods');
      covered.add(month);
    }
    const seen = new Set();
    for (const row of part.rows) {
      const identity = rowIdentity(row, aggregate);
      if (seen.has(identity)) throw invalid(aggregate === 'platform' ? 'missing or duplicate platform within a segment' : 'missing or duplicate SKU within a segment');
      seen.add(identity);
      const periods = new Map();
      let sum = 0;
      for (const p of row.statistics_rows) {
        const label = monthLabel(p.date);
        if (periods.has(label) || !expected.includes(label)) throw invalid('duplicate or unexpected CSV period');
        periods.set(label, p.value);
        sum = add(sum, p.value);
      }
      if (periods.size !== expected.length || sum !== row.sales_sum) throw invalid('missing periods or subtotal mismatch');
      let result = merged.get(identity);
      if (!result) {
        result = { ...row, sales_sum: 0, mean: null, csv: undefined, periods: new Map() };
        merged.set(identity, result);
      }
      result.sales_sum = add(result.sales_sum, row.sales_sum);
      for (const [month, value] of periods) result.periods.set(month, value);
    }
  }
  const months = [...covered].sort();
  return [...merged.values()].map(({ periods, ...row }) => {
    const values = new Map();
    for (const month of months) {
      const label = dimension === 'yearly' ? month.slice(0, 4) : month;
      values.set(label, add(values.get(label) || 0, periods.get(month) || 0));
    }
    return { ...row, statistics_rows: [...values].map(([date, value]) => ({ date, value })) };
  });
}

function createSplit({ getSessions, maxParallelExports, singleAccountDays, isActive = () => true, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), failureMessage = 'a segment failed; no partial export returned' }) {
  const concurrency = normalizeParallelExports(maxParallelExports);
  const smallRangeDays = normalizeSingleAccountDays(singleAccountDays);
  let gate = Promise.resolve(), nextSubmit = 0;
  function beforeSubmit() {
    const pending = gate.then(async () => {
      while (now() < nextSubmit) await sleep(nextSubmit - now());
      if (!isActive()) throw invalid('service is shutting down; no new export submitted');
      nextSubmit = now() + 3000;
    });
    gate = pending.catch(() => {});
    return pending;
  }
  return async function split(start, end, worker, { accounts = 1 } = {}) {
    const sessions = getSessions();
    if (!sessions.length) throw invalid('no ERP account is configured');
    const count = Math.min(sessions.length, concurrency, accounts);
    const ranges = splitMonths(start, end, count, smallRangeDays);
    const run = (range, index) => withErpContext(sessions[index], () => worker({
      session: sessions[index], range, index, count: ranges.length, beforeSubmit,
    }));
    if (ranges.length === 1) return [await run(ranges[0], 0)];
    const results = await Promise.allSettled(ranges.map(run));
    if (results.some(result => result.status === 'rejected')) throw invalid(failureMessage);
    return results.map(result => result.value);
  };
}

function canSplitSales(query, sort) {
  return sort !== 'mean' && ['sku', 'sku-platform', 'platform'].includes(query.aggregate_by || 'sku');
}

function createPool({ getSessions, scope, download, maxParallelExports, singleAccountDays, isActive, now, sleep }) {
  const split = createSplit({
    getSessions, maxParallelExports, singleAccountDays, isActive, now, sleep,
    failureMessage: 'a segment failed; no partial ranking returned',
  });
  return async function loadExport(options, { sort = 'sales' } = {}) {
    const { query, start, end, onProgress } = options;
    const aggregate = query.aggregate_by || 'sku';
    const results = await split(start, end, async ({ session, range, index, count, beforeSubmit }) => {
      if (count === 1) return download({ ...options, token: session.token, beforeSubmit });
      const partQuery = { ...query, date_dimension: 'monthly', date_range: `${range.start} & ${range.end}` };
      const result = await download({
        token: session.token, query: partQuery, ...range, beforeSubmit,
        onProgress: progress => onProgress?.({ ...progress, phase: `part ${index + 1}/${count}` }),
      });
      if (typeof result.fileIdentity !== 'string' || !result.fileIdentity) throw invalid('cannot verify distinct output files');
      return {
        ...range, ...result, rows: parseSalesCsv(result.file, {
          aggregateBy: aggregate, expectedPeriods: monthLabels(range.start, range.end),
        }),
      };
    }, { accounts: scope && canSplitSales(query, sort) ? Number.POSITIVE_INFINITY : 1 });
    if (results.length === 1) return results[0];
    if (new Set(results.map(part => part.fileIdentity)).size !== results.length) throw invalid('ERP output-file collision; discard all segments');
    return {
      rows: mergeParts(results, query.date_dimension, aggregate),
      taskId: results[0].taskId,
      taskIds: results.map(part => String(part.taskId)),
      parts: results.length,
    };
  };
}

module.exports = {
  splitMonths, mergeParts, createPool, createSplit,
  normalizeParallelExports, normalizeSingleAccountDays, monthLabels,
};
