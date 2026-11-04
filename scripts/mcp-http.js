#!/usr/bin/env bun
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { normalizeParallelExports } = require('./sales-account-pool.js');
const { normalizeSingleAccountDays } = require('./sales-account-pool.js');
const { normalizeCacheConfig } = require('./sales-export-cache.js');

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_INFLIGHT = 32;
const RATE_CAPACITY = 120;
const RATE_PER_SECOND = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARTIFACT_TYPES = new Map([
  ['result.json', 'application/json'],
  ['pages.ndjson', 'application/x-ndjson'],
  ['export.csv', 'text/csv'],
  ['export.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

function invalidConfiguration() {
  return new Error('Invalid remote MCP configuration.');
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidConfiguration();
  const allowed = new Set(['publicUrl', 'port', 'tokenFile', 'dataDir', 'sessionFiles', 'poolScope', 'maxParallelExports', 'singleAccountDays', 'salesCache']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw invalidConfiguration();
  if (typeof value.publicUrl !== 'string' || value.publicUrl.length > 2048) throw invalidConfiguration();

  let publicUrl;
  try { publicUrl = new URL(value.publicUrl); } catch { throw invalidConfiguration(); }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password
    || publicUrl.pathname !== '/mcp' || publicUrl.search || publicUrl.hash) {
    throw invalidConfiguration();
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.tokenFile !== 'string' || !path.isAbsolute(value.tokenFile)
    || typeof value.dataDir !== 'string' || !path.isAbsolute(value.dataDir)
    || !Array.isArray(value.sessionFiles) || value.sessionFiles.length < 1
    || value.sessionFiles.some(file => typeof file !== 'string' || !path.isAbsolute(file))) {
    throw invalidConfiguration();
  }
  const sessionFiles = value.sessionFiles.map(file => path.resolve(file));
  if (new Set(sessionFiles).size !== sessionFiles.length) throw invalidConfiguration();
  let maxParallelExports;
  try { maxParallelExports = normalizeParallelExports(value.maxParallelExports); } catch { throw invalidConfiguration(); }
  let singleAccountDays, salesCache;
  try {
    singleAccountDays = normalizeSingleAccountDays(value.singleAccountDays);
    salesCache = normalizeCacheConfig(value.salesCache);
  } catch { throw invalidConfiguration(); }

  let poolScope;
  if (Object.hasOwn(value, 'poolScope')) {
    const scope = value.poolScope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)
      || Object.keys(scope).length !== 2
      || scope.auctionSite !== 'JY' || scope.productTypeCate !== '5') {
      throw invalidConfiguration();
    }
    poolScope = { auctionSite: 'JY', productTypeCate: '5' };
  }

  return {
    publicUrl: publicUrl.href,
    publicOrigin: publicUrl.origin,
    publicHost: publicUrl.host,
    port: value.port,
    tokenFile: path.resolve(value.tokenFile),
    dataDir: path.resolve(value.dataDir),
    sessionFiles,
    maxParallelExports,
    singleAccountDays,
    salesCache,
    ...(poolScope ? { poolScope } : {}),
  };
}

function readPrivateFile(filename, label, maxBytes) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error(`Invalid ${label} file.`);
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077)) || stat.size > maxBytes) {
      throw new Error();
    }
    const data = fs.readFileSync(descriptor);
    if (data.length > maxBytes) throw new Error();
    return data;
  } catch {
    throw new Error(`Unable to read private ${label} file.`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function loadConfig(filename = process.env.NEW_ERP_HTTP_CONFIG) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw invalidConfiguration();
  let value;
  try {
    value = JSON.parse(readPrivateFile(filename, 'configuration', 64 * 1024).toString('utf8'));
  } catch {
    throw invalidConfiguration();
  }
  return validateConfig(value);
}

function readToken(filename) {
  const text = readPrivateFile(filename, 'token', 4096).toString('utf8');
  const token = text.replace(/\r?\n$/, '');
  if (!/^[\x21-\x7e]{32,1024}$/.test(token)) throw new Error('Invalid remote MCP token file.');
  return token;
}

async function ensurePrivateDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw invalidConfiguration();
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await fsp.lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalidConfiguration();
  const realPath = await fsp.realpath(directory);
  if (realPath === path.parse(realPath).root) throw invalidConfiguration();
  await fsp.chmod(realPath, 0o700);
  const stat = await fsp.lstat(realPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw invalidConfiguration();
  return realPath;
}

async function acquireProcessLock(directory) {
  const dataDir = await ensurePrivateDirectory(directory);
  const lockDir = path.join(dataDir, '.remote-mcp.lock');
  const ownerFile = path.join(lockDir, 'owner.json');
  const lockId = crypto.randomUUID();
  try {
    await fsp.mkdir(lockDir, { mode: 0o700 });
  } catch {
    throw new Error('Remote MCP process lock already exists; verify the previous process before removing it.');
  }
  try {
    await fsp.writeFile(ownerFile, JSON.stringify({ pid: process.pid, lockId }), { flag: 'wx', mode: 0o600 });
  } catch {
    await fsp.rmdir(lockDir).catch(() => {});
    throw new Error('Unable to establish the remote MCP process lock.');
  }
  let released = false;
  return {
    dataDir,
    async release() {
      if (released) return;
      released = true;
      try {
        const dirStat = await fsp.lstat(lockDir);
        const fileStat = await fsp.lstat(ownerFile);
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()
          || (fileStat.mode & 0o077)) return;
        const owner = JSON.parse(await fsp.readFile(ownerFile, 'utf8'));
        if (owner.pid !== process.pid || owner.lockId !== lockId) return;
        await fsp.unlink(ownerFile);
        await fsp.rmdir(lockDir);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function createRateLimiter({ capacity = RATE_CAPACITY, perSecond = RATE_PER_SECOND, now = Date.now } = {}) {
  let tokens = capacity;
  let updatedAt = now();
  return function takeToken() {
    const current = now();
    tokens = Math.min(capacity, tokens + Math.max(0, current - updatedAt) * perSecond / 1000);
    updatedAt = current;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

function secureHeaders(source) {
  const headers = new Headers(source);
  headers.set('cache-control', 'no-store, private');
  headers.set('pragma', 'no-cache');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  return headers;
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function responseWithHeaders(response, body = response.body) {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: secureHeaders(response.headers),
  });
}

function trackedResponse(response, release) {
  if (!response.body) {
    release();
    return responseWithHeaders(response, null);
  }
  const reader = response.body.getReader();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    release();
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          finish();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { finish(); }
    },
  });
  return responseWithHeaders(response, body);
}

async function boundedRequest(request, maxBytes) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw Object.assign(new Error(), { status: 400 });
  }
  if (length !== null && Number(length) > maxBytes) throw Object.assign(new Error(), { status: 413 });
  if (!request.body) return request;
  if (request.method === 'GET' || request.method === 'HEAD') {
    await request.body.cancel().catch(() => {});
    throw Object.assign(new Error(), { status: 400 });
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error(), { status: 413 });
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error(), { status: 400 });
  }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  try {
    return new Request(request.url, {
      method: request.method,
      headers,
      body: Buffer.concat(chunks),
      signal: request.signal,
    });
  } catch {
    throw Object.assign(new Error(), { status: 400 });
  }
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function transformArtifactPaths(value, publicUrl) {
  const origin = new URL(publicUrl).origin;
  function visit(current, jobId, state) {
    if (Array.isArray(current)) return current.map(item => visit(item, jobId, state));
    if (!current || typeof current !== 'object') return current;
    const nextJobId = typeof current.jobId === 'string' && UUID_PATTERN.test(current.jobId) ? current.jobId : jobId;
    const nextState = typeof current.state === 'string' ? current.state : state;
    const output = {};
    for (const [key, item] of Object.entries(current)) {
      if (key === 'artifact' && item && typeof item === 'object' && !Array.isArray(item)) {
        const artifact = { ...item };
        const filename = typeof artifact.path === 'string' ? path.basename(artifact.path) : '';
        delete artifact.path;
        if (nextState === 'succeeded' && artifact.complete === true && nextJobId && ARTIFACT_TYPES.has(filename)) {
          artifact.downloadUrl = new URL(`/artifacts/${nextJobId}`, origin).href;
        }
        output[key] = artifact;
      } else output[key] = visit(item, nextJobId, nextState);
    }
    return output;
  }
  return visit(value, undefined, undefined);
}

async function artifactResponse(jobId, config, runtime) {
  let handle;
  try {
    const session = await runtime.auth.requireSession();
    const status = await runtime.jobs.status(jobId, session);
    const artifact = status?.result?.artifact;
    if (status?.state !== 'succeeded' || artifact?.complete !== true || typeof artifact.path !== 'string') {
      return jsonResponse(404, { error: 'not_found' });
    }
    const filename = path.basename(artifact.path);
    const mediaType = ARTIFACT_TYPES.get(filename);
    if (!mediaType) return jsonResponse(404, { error: 'not_found' });

    const root = await fsp.realpath(config.dataDir);
    if (root !== config.dataDir) return jsonResponse(404, { error: 'not_found' });
    const jobsDir = path.join(root, '.mcp-jobs');
    const jobDir = path.join(jobsDir, jobId);
    const file = path.join(jobDir, filename);
    if (path.resolve(artifact.path) !== file) return jsonResponse(404, { error: 'not_found' });
    for (const directory of [root, jobsDir, jobDir]) {
      const stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
        return jsonResponse(404, { error: 'not_found' });
      }
    }
    const realFile = await fsp.realpath(file);
    if (realFile !== file || !isContained(root, realFile)) return jsonResponse(404, { error: 'not_found' });
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fsp.open(file, fs.constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > MAX_ARTIFACT_BYTES) {
      await handle.close();
      return jsonResponse(404, { error: 'not_found' });
    }
    const stream = Readable.toWeb(handle.createReadStream());
    handle = undefined;
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': mediaType,
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(stat.size),
      },
    });
  } catch {
    if (handle) await handle.close().catch(() => {});
    return jsonResponse(404, { error: 'not_found' });
  }
}

async function createHttpHandler({ config, token, runtime, maxRequestBytes = MAX_REQUEST_BYTES,
  maxInflight = MAX_INFLIGHT, rateCapacity = RATE_CAPACITY, ratePerSecond = RATE_PER_SECOND } = {}) {
  const settings = validateConfig({
    publicUrl: config?.publicUrl,
    port: config?.port,
    tokenFile: config?.tokenFile,
    dataDir: config?.dataDir,
    sessionFiles: config?.sessionFiles,
    maxParallelExports: config?.maxParallelExports,
    ...(config?.poolScope ? { poolScope: config.poolScope } : {}),
  });
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,1024}$/.test(token)
    || !runtime?.auth || typeof runtime.auth.requireSession !== 'function'
    || !runtime?.jobs || typeof runtime.jobs.status !== 'function') {
    throw new TypeError('HTTP handler dependencies are invalid.');
  }
  const { createMcpHandler } = await import('@modelcontextprotocol/server');
  const { createServer } = require('./mcp.js');
  const mcp = createMcpHandler(
    () => createServer({
      auth: runtime.auth,
      jobs: runtime.jobs,
      remote: true,
      transformOutput: output => transformArtifactPaths(output, settings.publicUrl),
    }),
    {
      responseMode: 'json',
      maxRequestBodySize: maxRequestBytes,
      maxSubscriptions: maxInflight,
      onerror: () => {},
    },
  );
  const expectedHash = sha256(token);
  const takeRateToken = createRateLimiter({ capacity: rateCapacity, perSecond: ratePerSecond });
  let inflight = 0;

  async function fetch(request) {
    let url;
    try { url = new URL(request.url); } catch { return responseWithHeaders(jsonResponse(400, { error: 'bad_request' }), null); }
    if (!takeRateToken()) return responseWithHeaders(jsonResponse(429, { error: 'rate_limited' }), null);
    if (!request.headers.get('host')
      || request.headers.get('host').toLowerCase() !== settings.publicHost.toLowerCase()
      || url.host.toLowerCase() !== settings.publicHost.toLowerCase()) {
      return responseWithHeaders(jsonResponse(421, { error: 'misdirected_request' }), null);
    }
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== settings.publicOrigin) {
      return responseWithHeaders(jsonResponse(403, { error: 'forbidden' }), null);
    }
    if ([...url.searchParams.keys()].some(key => /(token|authorization|bearer)/i.test(key))) {
      return responseWithHeaders(jsonResponse(400, { error: 'query_auth_not_allowed' }), null);
    }

    const isHealth = url.pathname === '/healthz' && request.method === 'GET';
    if (!isHealth) {
      const match = /^Bearer ([^\s]{1,1024})$/i.exec(request.headers.get('authorization') || '');
      const candidateHash = sha256(match ? match[1] : '');
      const valid = crypto.timingSafeEqual(expectedHash, candidateHash) && Boolean(match);
      if (!valid) return responseWithHeaders(jsonResponse(401, { error: 'unauthorized' }), null);
    }

    if (inflight >= maxInflight) return responseWithHeaders(jsonResponse(503, { error: 'busy' }), null);
    inflight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inflight -= 1;
    };
    try {
      if (isHealth) return trackedResponse(jsonResponse(200, { ok: true }), release);
      if (url.pathname === '/healthz') return trackedResponse(jsonResponse(405, { error: 'method_not_allowed' }), release);
      if (url.pathname.startsWith('/artifacts/')) {
        if (request.method !== 'GET') return trackedResponse(jsonResponse(405, { error: 'method_not_allowed' }), release);
        const match = /^\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
        if (!match) return trackedResponse(jsonResponse(404, { error: 'not_found' }), release);
        return trackedResponse(await artifactResponse(match[1], settings, runtime), release);
      }
      if (url.pathname !== '/mcp') return trackedResponse(jsonResponse(404, { error: 'not_found' }), release);
      const bounded = await boundedRequest(request, maxRequestBytes);
      return trackedResponse(await mcp.fetch(bounded), release);
    } catch (error) {
      release();
      const status = error.status === 400 || error.status === 413 ? error.status : 500;
      return responseWithHeaders(jsonResponse(status, { error: status === 413 ? 'request_too_large' : 'request_failed' }), null);
    }
  }

  fetch.close = () => mcp.close();
  return fetch;
}

async function startHttpServer({ env = process.env, bun = globalThis.Bun, runtimeFactory } = {}) {
  if (!bun || typeof bun.serve !== 'function') throw new Error('Bun runtime is required.');
  const config = loadConfig(env.NEW_ERP_HTTP_CONFIG);
  const token = readToken(config.tokenFile);
  const lock = await acquireProcessLock(config.dataDir);
  config.dataDir = lock.dataDir;
  let runtime;
  let handler;
  let server;
  try {
    const createRuntime = runtimeFactory || require('./mcp-remote-runtime.js').createRemoteRuntime;
    runtime = await createRuntime({
      rootDir: lock.dataDir,
      sessionFiles: config.sessionFiles,
      maxParallelExports: config.maxParallelExports,
      singleAccountDays: config.singleAccountDays,
      salesCache: config.salesCache,
      poolScope: config.poolScope,
    });
    handler = await createHttpHandler({ config, token, runtime });
    server = bun.serve({
      hostname: '127.0.0.1',
      port: config.port,
      fetch: handler,
    });
  } catch {
    try { await handler?.close(); } catch {}
    try { await runtime?.close?.(); } catch {}
    await lock.release().catch(() => {});
    throw new Error('Remote MCP server startup failed; check its private configuration and runtime.');
  }
  let closing;
  return {
    server,
    runtime,
    handler,
    close() {
      if (closing) return closing;
      closing = (async () => {
        try { server.stop(true); } finally {
          try { await handler.close(); } finally {
            try { await runtime.close(); } finally { await lock.release(); }
          }
        }
      })();
      return closing;
    },
  };
}

async function main() {
  let service;
  try {
    service = await startHttpServer();
  } catch {
    process.stderr.write('Remote MCP server failed to start; verify its private configuration and runtime.\n');
    process.exitCode = 1;
    return;
  }
  let stopping = false;
  const stop = async signal => {
    if (stopping) return;
    stopping = true;
    try {
      await service.close();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    } catch {
      process.exit(1);
    }
  };
  process.once('SIGINT', () => { void stop('SIGINT'); });
  process.once('SIGTERM', () => { void stop('SIGTERM'); });
}

module.exports = {
  MAX_REQUEST_BYTES,
  MAX_ARTIFACT_BYTES,
  acquireProcessLock,
  createHttpHandler,
  loadConfig,
  readToken,
  startHttpServer,
  transformArtifactPaths,
  validateConfig,
};

if (require.main === module) main();
