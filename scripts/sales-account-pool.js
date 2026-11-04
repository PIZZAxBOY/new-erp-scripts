const { withErpContext, CommandExecutionError } = require('./shared.js');
const { normalizeDateTime } = require('./sales-volume-ranking.js');
const { parseSalesCsv } = require('./sales-volume-csv.js');

function invalid(message) {
  return new CommandExecutionError(`Account pool: ${message}`);
}

const format = timestamp => new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');

function splitMonths(start, end, count) {
  const from = normalizeDateTime(start, 'startDate', false).timestamp;
  const to = normalizeDateTime(end, 'endDate', true).timestamp;
  if (to < from || !Number.isInteger(count) || count < 1 || count > 3) throw invalid('invalid split range or account count');
  const first = new Date(from), last = new Date(to);
  const months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1;
  if (months > 1200) throw invalid('date range exceeds 100 years');
  const boundaries = [from];
  for (let i = 1; i < months; i++) boundaries.push(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1));
  boundaries.push(to + 1000);
  const size = Math.min(count, months);
  return Array.from({ length: size }, (_, i) => ({
    start: format(boundaries[Math.floor(i * months / size)]),
    end: format(boundaries[Math.floor((i + 1) * months / size)] - 1000),
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

function mergeParts(parts, dimension) {
  const merged = new Map(), covered = new Set();
  for (const part of parts) {
    const expected = monthLabels(part.start, part.end);
    for (const month of expected) {
      if (covered.has(month)) throw invalid('overlapping split periods');
      covered.add(month);
    }
    const seen = new Set();
    for (const row of part.rows) {
      if (!row.sku || seen.has(row.sku)) throw invalid('missing or duplicate SKU within a segment');
      seen.add(row.sku);
      const periods = new Map();
      let sum = 0;
      for (const p of row.statistics_rows) {
        const label = monthLabel(p.date);
        if (periods.has(label) || !expected.includes(label)) throw invalid('duplicate or unexpected CSV period');
        periods.set(label, p.value);
        sum = add(sum, p.value);
      }
      if (periods.size !== expected.length || sum !== row.sales_sum) throw invalid('missing periods or subtotal mismatch');
      let result = merged.get(row.sku);
      if (!result) {
        result = { ...row, sales_sum: 0, mean: null, csv: undefined, periods: new Map() };
        merged.set(row.sku, result);
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

function createPool({ getSessions, scope, download, isActive = () => true, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
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
  return async function loadExport(options, { sort = 'sales' } = {}) {
    const sessions = getSessions();
    const { query, start, end, onProgress } = options;
    const eligible = scope && query.auction_site === scope.auctionSite && query.product_type_cate === scope.productTypeCate
      && query.aggregate_by === 'sku' && !query.auction_site_type && !query.catalog_id && sort !== 'mean';
    const ranges = splitMonths(start, end, eligible ? sessions.length : 1);
    if (ranges.length === 1) {
      return withErpContext(sessions[0], () => download({ ...options, token: sessions[0].token, beforeSubmit }));
    }
    const results = await Promise.allSettled(ranges.map((range, index) => withErpContext(sessions[index], async () => {
      const partQuery = { ...query, date_dimension: 'monthly', date_range: `${range.start} & ${range.end}` };
      const result = await download({ token: sessions[index].token, query: partQuery, ...range, beforeSubmit,
        onProgress: progress => onProgress?.({ ...progress, phase: `part ${index + 1}/${ranges.length}` }) });
      if (typeof result.fileIdentity !== 'string' || !result.fileIdentity) throw invalid('cannot verify distinct output files');
      return { ...range, ...result, rows: parseSalesCsv(result.file, {
        aggregateBy: 'sku', expectedPeriods: monthLabels(range.start, range.end),
      }) };
    })));
    const failure = results.find(r => r.status === 'rejected');
    if (failure) throw invalid('a segment failed; no partial ranking returned');
    const parts = results.map(r => r.value);
    if (new Set(parts.map(p => p.fileIdentity)).size !== parts.length) throw invalid('ERP output-file collision; discard all segments');
    return { rows: mergeParts(parts, query.date_dimension), taskId: parts[0].taskId, parts: parts.length };
  };
}

module.exports = { splitMonths, mergeParts, createPool };
