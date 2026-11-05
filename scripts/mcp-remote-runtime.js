const { readSession, sessionExpired } = require('./local-session.js');
const { normalizeBaseUrl } = require('./shared.js');
const { ownerOf } = require('./mcp-job-store.js');
const { createJobs } = require('./mcp-jobs.js');
const { createPool, createSplit, normalizeParallelExports } = require('./sales-account-pool.js');
const { normalizeSingleAccountDays } = require('./sales-account-pool.js');
const { mergeXlsx } = require('./xlsx-merge.js');
const { createSalesCache } = require('./sales-export-cache.js');
const { createSalesDataStore, normalizeDataConfig } = require('./sales-data-store.js');
const catalog = require('./mcp-catalog.js');

function createRemoteRuntime({ rootDir, sessionFiles, poolScope, maxParallelExports, singleAccountDays, salesCache, salesData }) {
  let closed = false;
  if (!Array.isArray(sessionFiles) || sessionFiles.length < 1) throw new Error('Configure at least one session file');
  const concurrency = normalizeParallelExports(maxParallelExports);
  const smallRangeDays = normalizeSingleAccountDays(singleAccountDays);
  const cache = createSalesCache({ rootDir, config: salesCache });
  const dataConfig = normalizeDataConfig(salesData);
  const storage = createSalesDataStore({ rootDir, config: dataConfig });
  if (poolScope && (poolScope.auctionSite !== 'JY' || poolScope.productTypeCate !== '5'
    || Object.keys(poolScope).some(k => !['auctionSite', 'productTypeCate'].includes(k)))) {
    throw new Error('Only explicitly verified JY top-level scope supports pooling');
  }
  function sessions() {
    try {
      if (closed) throw new Error();
      const values = sessionFiles.map(file => readSession(file));
      if (values.some(s => !s || sessionExpired(s) || !s.username.trim())) throw new Error();
      const urls = values.map(s => normalizeBaseUrl(s.baseUrl));
      if (new Set(urls).size !== 1 || new URL(urls[0]).protocol !== 'https:') throw new Error();
      if (new Set(values.map(ownerOf)).size !== values.length
        || new Set(values.map(s => s.username.toLowerCase().trim())).size !== values.length) throw new Error();
      return values;
    } catch {
      throw Object.assign(new Error('Server ERP accounts require administrator attention'), { code: 'LOGIN_REQUIRED' });
    }
  }
  const auth = {
    requireSession: () => sessions()[0],
    status() {
      try { sessions(); return { state: 'authenticated', loggedIn: true, accounts: sessionFiles.length, poolEnabled: Boolean(poolScope), maxParallelExports: concurrency }; }
      catch { return { state: 'login_required', loggedIn: false, accounts: sessionFiles.length }; }
    },
    async close() {},
  };
  const load = createPool({ getSessions: sessions, scope: poolScope, maxParallelExports: concurrency, singleAccountDays: smallRangeDays, isActive: () => !closed,
    download: options => require('./sales-volume-export.js').downloadSalesCsv(options) });
  const split = createSplit({ getSessions: sessions, maxParallelExports: concurrency, singleAccountDays: smallRangeDays, isActive: () => !closed,
    failureMessage: 'a segment failed; no partial export returned' });
  async function accountSplit({ start, end, query, run }) {
    const results = await split(start, end, ({ range, beforeSubmit, index, count }) => run(range, { beforeSubmit, index, count }), {
      accounts: poolScope ? Number.POSITIVE_INFINITY : 1,
    });
    if (results.length === 1) return results[0];
    const files = results.map(result => result.file).filter(Buffer.isBuffer);
    const file = files.length ? mergeXlsx(files) : null;
    const boxes = results.reduce((sum, result) => sum + (Number.isFinite(result.boxes) ? result.boxes : 0), 0);
    const taskIds = results.map(result => String(result.taskId || '')).filter(Boolean);
    return { taskId: taskIds[0] || '', taskIds, query, boxes, parts: results.length, file };
  }
  const jobs = createJobs({ rootDir, getOperation(name) {
    const operation = catalog.getOperation(name);
    if (name === 'sales_volume_export') return { ...operation, invoke(params, hooks) {
      return require('./sales-volume-export.js').main({ ...params, output: hooks.outputPath, onProgress: hooks.onProgress,
        loadExport: options => {
          const context = { identity: { accounts: sessions().map(ownerOf), poolScope, concurrency, smallRangeDays,
            cacheEpoch: salesCache?.epoch || '' } };
          const download = request => load(request, { sort: 'sales' });
          if (!dataConfig.enabled) return cache.load(options, context, () => download(options));
          return storage.load(options, { ...context, allowRangeReuse: true }, download);
        } });
    } };
    if (name === 'packing_detail_export') return { ...operation, invoke(params, hooks) {
      return require('./packing-detail-export.js').main({ ...params, output: hooks.outputPath, onProgress: hooks.onProgress, accountSplit });
    } };
    if (name !== 'sales_volume_ranking') return operation;
    return { ...operation, invoke(params, hooks) {
      return require('./sales-volume-ranking.js').main({ ...params, onProgress: hooks.onProgress,
        loadExport: options => {
          const context = { identity: { accounts: sessions().map(ownerOf), poolScope, concurrency, smallRangeDays,
            mean: params.sort === 'mean', cacheEpoch: salesCache?.epoch || '' }, forceRefresh: params.forceRefresh };
          if (!dataConfig.enabled) return cache.load(options, context, () => load(options, { sort: params.sort }));
          const allowRangeReuse = params.sort !== 'mean';
          return storage.load(options, { ...context, allowRangeReuse }, request => load(request, { sort: params.sort }));
        } });
    } };
  } });
  return { auth, jobs, async close() { closed = true; await jobs.close(); await auth.close(); } };
}

module.exports = { createRemoteRuntime };
