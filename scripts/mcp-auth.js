const { readSession, removeSession, sessionExpired } = require('./local-session.js');
const { getBaseUrl, normalizeBaseUrl } = require('./shared.js');
const { runBrowserLogin } = require('./login-browser.js');

function loginRequired() {
  return Object.assign(new Error('ERP 尚未登录或会话已失效'), { code: 'LOGIN_REQUIRED' });
}

function createAuth({ openBrowser, browserTimeoutMs = 300_000 } = {}) {
  let pending;
  let closed = false;
  let lastMessage;

  function requireSession() {
    let session;
    try { session = readSession(); } catch { throw loginRequired(); }
    if (!session || sessionExpired(session)) throw loginRequired();
    try { normalizeBaseUrl(session.baseUrl); } catch { throw loginRequired(); }
    return session;
  }

  function status() {
    let session;
    try { session = requireSession(); } catch {}
    return {
      state: pending ? 'login_pending' : session ? 'authenticated' : 'login_required',
      loggedIn: Boolean(session),
      ...(session ? { baseUrl: session.baseUrl, username: session.username, expireTime: session.expireTime } : {}),
      ...(pending?.url ? { url: pending.url } : {}),
      ...(lastMessage ? { message: lastMessage } : {}),
    };
  }

  async function login() {
    if (closed) throw Object.assign(new Error('MCP 登录服务已关闭'), { code: 'SERVICE_CLOSED' });
    if (pending) return pending.ready;
    let baseUrl = '', username = '';
    try { baseUrl = getBaseUrl(); } catch {}
    try { username = readSession()?.username || ''; } catch {}
    const controller = new AbortController();
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const attempt = { controller, ready, url: undefined, done: undefined };
    pending = attempt;
    lastMessage = undefined;
    attempt.done = runBrowserLogin({ defaults: { baseUrl, username }, signal: controller.signal,
      timeoutMs: browserTimeoutMs, ...(openBrowser === undefined ? {} : { openBrowser }),
      onReady(url) {
        attempt.url = url;
        resolveReady({ state: 'login_pending', url, expiresInSeconds: Math.ceil(browserTimeoutMs / 1000) });
      },
    }).then(() => {
      lastMessage = undefined;
    }, () => {
      lastMessage = '网页登录未完成；可重新启动登录。';
      rejectReady(Object.assign(new Error('无法完成本机网页登录，请重试'), { code: 'LOGIN_INCOMPLETE' }));
    }).finally(() => {
      if (pending === attempt) pending = undefined;
    });
    return ready;
  }

  async function stopPending() {
    const attempt = pending;
    if (attempt) {
      attempt.controller.abort();
      await attempt.done;
    }
  }

  async function logout() {
    await stopPending();
    removeSession();
    lastMessage = undefined;
    return status();
  }

  async function close() {
    closed = true;
    await stopPending();
  }

  return { login, status, logout, requireSession, close };
}

module.exports = { createAuth };
