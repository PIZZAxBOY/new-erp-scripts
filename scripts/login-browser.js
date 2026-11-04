const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { CommandExecutionError, loginToken, normalizeBaseUrl, requiredString, withErpContext } = require('./shared.js');
const { saveSession } = require('./local-session.js');

const BODY_LIMIT = 16 * 1024;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function page({ route, csrf, defaults, error, complete = false }) {
  const hidden = `<input type="hidden" name="csrf" value="${csrf}">`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${complete ? '登录成功' : 'ERP 登录'}</title>
<style>
*{box-sizing:border-box}body{margin:0;color:#152c29;background:#f4f7f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;min-height:100vh;display:grid;place-items:center;padding:40px 20px;background-image:radial-gradient(ellipse at 15% 0%,#e5f0e9,transparent 50%)}
main{width:100%;max-width:480px}.brand{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;margin:0 0 26px 4px}.mark{background:#164e41;color:white;border-radius:11px;padding:10px;font-size:13px;letter-spacing:1px}
.card{background:#fff;border:1px solid #e0e8e3;border-radius:22px;padding:36px;box-shadow:0 18px 55px #193d2710}h1{font-size:28px;letter-spacing:-.7px;margin:0 0 26px;font-weight:650}.intro{font-size:14px;line-height:1.8;color:#718078;margin:0}
label{display:block;font-size:13px;font-weight:600;margin:22px 0 9px}input{display:block;width:100%;border:1px solid #d9e2dc;border-radius:10px;padding:13px 14px;font-size:15px;color:#203a30;background:#fbfcfb;outline:none;transition:border-color .15s,box-shadow .15s}input:focus{border-color:#3c8068;box-shadow:0 0 0 3px #3c806815}input::placeholder{color:#a4b0a9}
button{font:inherit;cursor:pointer}.primary{margin-top:28px;width:100%;border:0;background:#205e4c;color:white;font-size:14px;font-weight:600;border-radius:10px;padding:15px;transition:background .15s}.primary:hover{background:#164a3b}.privacy{margin:22px 0 0;padding:15px 0 0;border-top:1px solid #edf0ed;font-size:12px;color:#7b8981;line-height:1.8}.cancel{text-align:center;margin-top:15px}.cancel button{border:0;background:none;color:#87968b;font-size:12px;padding:8px}.error{color:#a93a32;background:#fff3f1;border:1px solid #f3ded9;padding:12px;border-radius:9px;font-size:13px;line-height:1.6}.success{display:grid;place-items:center;width:48px;height:48px;background:#e8f3ec;color:#2c7051;border-radius:50%;font-size:25px;margin-bottom:22px}.foot{text-align:center;color:#99a59e;font-size:11px;margin:24px 0 0;letter-spacing:.4px}@media(max-width:520px){body{padding:24px 16px}.card{padding:28px 24px;border-radius:18px}h1{font-size:26px}}
</style></head><body><main><div class="brand"><span class="mark">ERP</span>New ERP</div>
<section class="card">${complete ? '<div class="success">✓</div><h1>登录成功</h1><p class="intro">配置已保存，可以关闭此页面，返回对话继续查询。</p>' : `
<h1>ERP 登录</h1>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${route}" autocomplete="on">${hidden}
<label for="baseUrl">ERP 网址</label><input id="baseUrl" name="baseUrl" type="url" value="${escapeHtml(defaults.baseUrl)}" placeholder="https://your-erp.example.com" required autocomplete="url" spellcheck="false">
<label for="username">账号</label><input id="username" name="username" value="${escapeHtml(defaults.username)}" placeholder="输入 ERP 账号" required autocomplete="username">
<label for="password">密码</label><input id="password" name="password" type="password" placeholder="输入 ERP 密码" required autocomplete="current-password">
<button class="primary" type="submit">登录</button></form>
<p class="privacy">密码不进入 AI 对话；仅保存本机会话，不保存密码。</p>`}</section>
${complete ? '' : `<form class="cancel" method="post" action="${route}/cancel">${hidden}<button type="submit">取消登录</button></form>`}
${complete ? '' : '<p class="foot">本次登录页面将在 5 分钟后失效</p>'}</main></body></html>`;
}

function openLocalBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > BODY_LIMIT) {
        chunks.length = 0;
        reject(new Error('body-too-large'));
      } else chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
    request.once('aborted', () => reject(new Error('request-aborted')));
  });
}

async function runBrowserLogin({ defaults = {}, openBrowser = openLocalBrowser,
  onReady = (url) => process.stderr.write(`请在浏览器中完成 ERP 登录：${url}\n`),
  signal, timeoutMs = 300_000 } = {}) {
  if (signal?.aborted) throw new CommandExecutionError('网页登录已取消');
  const route = `/login/${randomBytes(24).toString('hex')}`;
  const csrf = randomBytes(24).toString('hex');
  const shutdown = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let phase = 'ready';
  let origin;
  let timer;
  let drain;
  let committed;

  return new Promise((resolve, reject) => {
    function finish(error) {
      if (phase === 'settled') return;
      if (committed) error = undefined;
      phase = 'settled';
      clearTimeout(timer);
      clearTimeout(drain);
      signal?.removeEventListener('abort', cancel);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      shutdown.abort();
      server.close(() => error ? reject(error) : resolve(committed));
      server.closeAllConnections();
    }
    function cancel() { finish(new CommandExecutionError('网页登录已取消')); }
    function respond(response, status, html) {
      response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        Connection: 'close',
      });
      response.end(html);
    }
    function endRun(response, status, html, error) {
      phase = committed ? 'committed' : 'closing';
      clearTimeout(timer);
      drain = setTimeout(() => finish(error), 250);
      response.once('finish', () => finish(error));
      respond(response, status, html);
    }
    const render = (values, error, complete) => page({ route, csrf, defaults: values, error, complete });
    async function handle(request, response) {
      const rejectRequest = (status) => respond(response, status, '请求无效，请重新打开登录链接。');
      if (request.headers.host !== new URL(origin).host) return rejectRequest(403);
      if (request.url !== route && request.url !== `${route}/cancel`) return rejectRequest(404);
      if (request.method === 'GET' && request.url === route) return respond(response, 200, render(defaults));
      if (request.method !== 'POST') return rejectRequest(405);
      if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') return rejectRequest(403);
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return rejectRequest(415);
      const canceling = request.url === `${route}/cancel`;
      if (phase !== 'ready' && !(canceling && phase === 'authenticating')) return rejectRequest(409);
      let body;
      try { body = await readBody(request); } catch { return rejectRequest(413); }
      if (phase !== 'ready' && !(canceling && phase === 'authenticating')) return rejectRequest(409);
      if (/%(?![a-f0-9]{2})/i.test(body)) return rejectRequest(400);
      const fields = new URLSearchParams(body);
      if ([...fields.keys()].some((key) => !['csrf', 'baseUrl', 'username', 'password'].includes(key) || fields.getAll(key).length !== 1)) return rejectRequest(400);
      if (fields.get('csrf') !== csrf) return rejectRequest(403);
      if (canceling) {
        shutdown.abort();
        return endRun(response, 200, '登录已取消，可以关闭此页面。', new CommandExecutionError('网页登录已取消'));
      }
      let baseUrl, username, password;
      try {
        baseUrl = normalizeBaseUrl(fields.get('baseUrl'));
        username = requiredString(fields.get('username'), 'username');
        password = requiredString(fields.get('password'), 'password');
      } catch { return respond(response, 400, render(defaults, '请填写有效的 ERP 网址、账号和密码。')); }
      phase = 'authenticating';
      let session;
      try {
        session = await withErpContext({ baseUrl }, () => loginToken({ username, password, signal: shutdown.signal }));
      } catch {
        if (phase !== 'authenticating') return;
        phase = 'ready';
        return respond(response, 401, render({ baseUrl, username }, '登录失败，请检查 ERP 地址、账号和密码后重试。'));
      }
      if (phase !== 'authenticating' || shutdown.signal.aborted || Date.now() >= deadline) return;
      let sessionFile;
      try { sessionFile = saveSession({ baseUrl, ...session }); } catch {
        return endRun(response, 500, render({ baseUrl, username }, '无法保存本机登录会话，请重新启动登录。'),
          new CommandExecutionError('无法保存本机登录会话'));
      }
      committed = { baseUrl, username: session.username, userId: session.userId,
        expireTime: session.expireTime, sessionFile, loggedIn: true };
      endRun(response, 200, render({}, undefined, true));
    }
    const server = http.createServer((request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent) respond(response, 500, '登录服务暂不可用，请重新启动登录。');
        finish(new CommandExecutionError('网页登录服务异常，请重新运行登录命令'));
      });
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.maxConnections = 8;
    server.once('error', () => finish(new CommandExecutionError('无法启动本机登录页面')));
    signal?.addEventListener('abort', cancel, { once: true });
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    timer = setTimeout(() => finish(new CommandExecutionError('登录页面已过期，请通过 erp_execute 的 auth.login 重新打开')), timeoutMs);
    server.listen(0, '127.0.0.1', () => {
      if (phase === 'settled') return;
      origin = `http://127.0.0.1:${server.address().port}`;
      const url = `${origin}${route}`;
      try { onReady(url); } catch { return finish(new CommandExecutionError('无法显示登录链接')); }
      if (openBrowser && phase !== 'settled') Promise.resolve().then(() => openBrowser(url)).catch(() => {
        if (phase !== 'settled') process.stderr.write('无法自动打开浏览器，请手动打开上面的本机登录链接。\n');
      });
    });
  });
}

module.exports = { runBrowserLogin };
