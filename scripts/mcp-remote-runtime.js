const { readSession, sessionExpired } = require('./local-session.js');
const { normalizeBaseUrl } = require('./shared.js');
const { ownerOf } = require('./mcp-job-store.js');
const { createJobs } = require('./mcp-jobs.js');
const { createPool, normalizeParallelExports } = require('./sales-account-pool.js');
const { normalizeSingleAccountDays } = require('./sales-account-pool.js');
const { createSalesCache } = require('./sales-export-cache.js');
const catalog = require('./mcp-catalog.js');

function createRemoteRuntime({ rootDir, sessionFiles, poolScope, maxParallelExports, singleAccountDays, salesCache }) {
  let closed = false;
  if (!Array.isArray(sessionFiles) || sessionFiles.length < 1) throw new Error('Configure at least one session file');
  const concurrency = normalizeParallelExports(maxParallelExports);
  const smallRangeDays = normalizeSingleAccountDays(singleAccountDays);
  const cache = createSalesCache({ rootDir, config: salesCache });
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
  const jobs = createJobs({ rootDir, getOperation(name) {
    const operation = catalog.getOperation(name);
    if (name !== 'sales_volume_ranking') return operation;
    return { ...operation, invoke(params, hooks) {
      return require('./sales-volume-ranking.js').main({ ...params, onProgress: hooks.onProgress,
        loadExport: options => cache.load(options, {
          identity: { accounts: sessions().map(ownerOf), poolScope, concurrency, smallRangeDays, mean: params.sort === 'mean' },
          forceRefresh: params.forceRefresh,
        }, () => load(options, { sort: params.sort })) });
    } };
  } });
  return { auth, jobs, async close() { closed = true; await jobs.close(); await auth.close(); } };
}

module.exports = { createRemoteRuntime };
