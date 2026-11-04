const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function sessionFilePath() {
  if (process.env.NEW_ERP_SESSION_FILE?.trim()) return path.resolve(process.env.NEW_ERP_SESSION_FILE.trim());
  const directory = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(directory, 'new-erp', 'session.json');
}

function readSession(file = sessionFilePath()) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
      throw new Error('Session file must be a private regular file; authenticate again with auth.login through erp_execute');
    }
    const session = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (session?.version !== 1 || typeof session.baseUrl !== 'string' || !session.baseUrl
      || typeof session.token !== 'string' || !session.token.trim() || typeof session.username !== 'string') {
      throw new Error('Invalid session');
    }
    return session;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read local ERP session; authenticate again with auth.login through erp_execute');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function saveSession({ baseUrl, username, token, userId, expireTime }) {
  const filename = sessionFilePath();
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, baseUrl, username, token,
      userId: userId ?? null, expireTime: expireTime ?? null }, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return filename;
}

function removeSession() {
  try { fs.unlinkSync(sessionFilePath()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function sessionExpired(session) {
  const value = session.expireTime;
  if (value === null || value === undefined || value === '' || Number(value) === 0) return false;
  const number = Number(value);
  const expiresAt = Number.isFinite(number) ? number * (number < 1e12 ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

module.exports = { sessionFilePath, readSession, saveSession, removeSession, sessionExpired };
