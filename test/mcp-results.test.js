const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { z } = require('zod/v4');
const { createJobs } = require('../scripts/mcp-jobs.js');
const { salesSummary, resultPage } = require('../scripts/mcp-results.js');

const session = { baseUrl: 'https://erp.invalid', userId: 7, token: 'example-token' };
const params = { source: 'export', startDate: '2025-01-15', endDate: '2025-12-20',
  aggregateBy: 'sku', auctionSite: 'YS', productTypeCate: '5', dateDimension: 'monthly', fetchAll: true };
function rows(count = 40) {
  return Array.from({ length: count }, (_, index) => ({ sku: `SKU-${index}`, source: 'export', totalCount: count,
    sales: 12 * index, periodValues: JSON.stringify(Array.from({ length: 12 }, (_, m) => ({ date: `2025-${String(m + 1).padStart(2, '0')}`, value: index }))) }));
}
function record(query = params) { return { jobId: 'fixture', operation: 'sales_volume_ranking', params: query, updatedAt: '2026-01-01T00:00:00Z' }; }

async function setup(t, value = rows()) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-results-'));
  let calls = 0;
  const jobs = createJobs({ rootDir, getOperation: () => ({ effect: 'export', schema: z.record(z.string(), z.unknown()), invoke: () => { calls++; return value; } }) });
  t.after(async () => { await jobs.close(); await fs.rm(rootDir, { recursive: true, force: true }); });
  const job = await jobs.start('sales_volume_ranking', params, session, { requestId: 'fixture' });
  assert.equal(job.state, 'succeeded');
  return { rootDir, jobs, job, calls: () => calls };
}

test('complete historical artifacts are paged intact and summarized without a new export, including MCP routing', async t => {
  const original = rows();
  const { jobs, job, calls } = await setup(t, original);
  assert.ok(job.result.artifact);
  assert.equal(job.resultAccess.read.operation, 'jobs.read');
  const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
  const { createServer } = require('../scripts/mcp.js');
  const server = await createServer({ remote: true, jobs, auth: { requireSession: () => session } });
  const client = new Client({ name: 'results-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const discover = await call('erp_discover', { operation: 'jobs.read' });
  assert.ok(discover.inputSchema.properties.fields);
  let offset = 0; const collected = [];
  do {
    const page = await call('erp_execute', { operation: 'jobs.read', params: { jobId: job.jobId, offset, limit: 7 } });
    collected.push(...page.list); offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(collected, original);
  const summary = await call('erp_execute', { operation: 'jobs.sales_summary', params: { jobId: job.jobId } });
  assert.equal(summary.skuCount, 40);
  assert.equal(summary.totalSales, 9360);
  assert.deepEqual(summary.periods.map(p => p.sales), Array(12).fill(780));
  assert.equal(summary.query.startDate, '2025-01-15');
  assert.equal(calls(), 1);
  assert.deepEqual((await jobs.readResult(job.jobId, session, { fields: ['sku', 'periodValues'], limit: 1 })).list,
    [{ sku: original[0].sku, periodValues: original[0].periodValues }]);
  for (const action of ['readResult', 'summarizeSales']) {
    await assert.rejects(jobs[action](job.jobId, { ...session, userId: 8 }), { code: 'NOT_FOUND' });
  }
});

test('inline results work and byte budgets reduce rows without truncating fields', async t => {
  const { jobs, job } = await setup(t, rows(2));
  assert.ok(job.result.data);
  assert.equal((await jobs.summarizeSales(job.jobId, session)).totalSales, 12);
  const large = { list: Array.from({ length: 5 }, () => ({ sku: 'A', detail: '中'.repeat(3000) })) };
  const page = resultPage(large, { limit: 5 });
  assert.equal(page.returnedCount, 2); assert.equal(page.nextOffset, 2);
  assert.equal(page.list[0].detail.length, 3000);
  assert.throws(() => resultPage({ list: [{ detail: 'x'.repeat(25000) }] }), { code: 'RESULT_ROW_TOO_LARGE' });
  assert.deepEqual(resultPage({ list: [{ sku: 'A', detail: 'x'.repeat(25000) }] }, { fields: ['sku'] }).list, [{ sku: 'A' }]);
  assert.throws(() => resultPage(large, { offset: -1 }), { code: 'INVALID_INPUT' });
});

test('summary fails closed for partial results, duplicate SKU, missing periods, subtotal mismatch and unsafe sums', () => {
  assert.throws(() => salesSummary(record(), { list: rows().slice(0, 2) }), { code: 'SALES_SUMMARY_INCOMPLETE' });
  assert.throws(() => salesSummary(record({ ...params, source: 'list' }), { list: rows() }), { code: 'SALES_SUMMARY_INCOMPLETE' });
  assert.throws(() => salesSummary(record({ ...params, aggregateBy: 'sku-platform' }), { list: rows() }), { code: 'SALES_SUMMARY_INCOMPLETE' });
  for (const mutate of [
    r => { r[1].sku = r[0].sku; },
    r => { r[0].periodValues = '[]'; },
    r => { r[0].sales = 1; },
    r => { r[0].periodValues = 'invalid'; },
    r => { r[0].periodValues = JSON.stringify(Array(12).fill({ date: '2025-01', value: 0 })); },
    r => { r[0].periodValues = JSON.stringify(JSON.parse(r[0].periodValues).map(p => ({ ...p, value: Number.MAX_SAFE_INTEGER }))); },
  ]) {
    const value = rows(); mutate(value);
    assert.throws(() => salesSummary(record(), { list: value }), { code: 'SALES_SUMMARY_INVALID' });
  }
});

test('yearly labels and signed values retain exact totals', () => {
  const result = salesSummary(record({ ...params, dateDimension: 'yearly' }), { list: [
    { sku: 'A', source: 'export', totalCount: 1, sales: -2, periodValues: '[{"date":"2025年","value":-2}]' },
  ] });
  assert.deepEqual(result.periods, [{ date: '2025', sales: -2 }]);
});

test('artifact access rejects unsafe paths, symlinks, incomplete and unsuccessful jobs', async t => {
  const { rootDir, jobs, job } = await setup(t);
  const dir = path.join(rootDir, '.mcp-jobs', job.jobId);
  const jobPath = path.join(dir, 'job.json');
  const saved = JSON.parse(await fs.readFile(jobPath, 'utf8'));
  for (const [change, code] of [
    [r => { r.state = 'failed'; }, 'RESULT_NOT_READY'],
    [r => { r.result.artifact.complete = false; }, 'RESULT_UNSAFE'],
    [r => { r.result.artifact.path = path.join(rootDir, 'outside.json'); }, 'RESULT_UNSAFE'],
    [r => { r.result.artifact.bytes++; }, 'RESULT_UNSAFE'],
  ]) {
    const modified = structuredClone(saved); change(modified);
    await fs.writeFile(jobPath, JSON.stringify(modified));
    await assert.rejects(jobs.readResult(job.jobId, session), { code });
  }
  await fs.writeFile(jobPath, JSON.stringify(saved));
  if (process.platform !== 'win32') {
    await fs.rename(path.join(dir, 'result.json'), path.join(dir, 'real.json'));
    await fs.symlink(path.join(dir, 'real.json'), path.join(dir, 'result.json'));
    await assert.rejects(jobs.readResult(job.jobId, session), { code: 'RESULT_UNSAFE' });
  }
});
