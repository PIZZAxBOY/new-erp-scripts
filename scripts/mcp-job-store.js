const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function ownerOf(session) {
  if (!session?.baseUrl || (session.userId == null && !session.username)) throw failure('AUTH_REQUIRED', 'A personal ERP session is required.');
  const url = new URL(session.baseUrl);
  url.hash = ''; url.search = '';
  if (url.username || url.password) throw failure('AUTH_REQUIRED', 'A personal ERP session is required.');
  return digest(canonical([url.toString().replace(/\/+$/, ''), session.userId != null ? ['id', String(session.userId)] : ['name', session.username]]));
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function createStore(rootDir) {
  const root = path.resolve(rootDir || process.env.NEW_ERP_EXPORT_DIR || path.join(os.homedir(), 'Downloads', 'new-erp'));
  const jobsDir = path.join(root, '.mcp-jobs');
  async function privateDir(dir) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
  }
  async function init() {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await privateDir(jobsDir);
    await privateDir(path.join(jobsDir, 'requests'));
    await privateDir(path.join(jobsDir, 'exports'));
  }
  function jobDir(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw failure('NOT_FOUND', 'Job not found.');
    return path.join(jobsDir, id);
  }
  async function read(id) {
    try { return JSON.parse(await fs.readFile(path.join(jobDir(id), 'job.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw failure('NOT_FOUND', 'Job not found.'); throw error; }
  }
  async function write(record) {
    const dir = jobDir(record.jobId);
    const temp = path.join(dir, `${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, path.join(dir, 'job.json'));
    } finally { await fs.rm(temp, { force: true }); }
  }
  return { root, jobsDir, init, jobDir, read, write, privateDir };
}

module.exports = { createStore, ownerOf, canonical, digest, failure, alive };
