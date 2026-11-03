#!/usr/bin/env node
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { ArgumentError, getBaseUrl, loginToken, normalizeBaseUrl, requiredString, runCli,
  withErpContext } = require('./shared.js');
const { saveSession, readSession } = require('./local-session.js');

async function promptCredentials(username) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new ArgumentError('Run new-erp login in a terminal, or provide NEW_ERP_USERNAME and NEW_ERP_PASSWORD');
  }
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!hidden) process.stderr.write(chunk, encoding);
    callback();
  } });
  const terminal = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    const user = username || await terminal.question('ERP 账号: ');
    process.stderr.write('ERP 密码: ');
    hidden = true;
    const password = await terminal.question('');
    process.stderr.write('\n');
    return { username: user, password };
  } finally {
    terminal.close();
    output.end();
  }
}

async function main(options = {}) {
  if (options.browser) {
    let baseUrl = '';
    try { baseUrl = normalizeBaseUrl(options.baseUrl || getBaseUrl()); } catch {}
    let username = options.username || process.env.NEW_ERP_USERNAME || '';
    if (!username) try { username = readSession()?.username || ''; } catch {}
    const { runBrowserLogin } = require('./login-browser.js');
    return runBrowserLogin({ defaults: { baseUrl, username },
    ...(options.open === false ? { openBrowser: false } : {}) });
  }
  let baseUrl;
  try {
    baseUrl = options.baseUrl ? normalizeBaseUrl(options.baseUrl) : getBaseUrl();
  } catch (error) {
    if (!(error instanceof ArgumentError) || error.message !== 'NEW_ERP_BASE_URL is required') throw error;
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new ArgumentError('首次登录需要 ERP 地址。请运行 new-erp login --baseUrl <ERP_URL>，或配置 NEW_ERP_BASE_URL；密码使用客户端私密输入或在自己的终端隐藏输入。');
    }
    const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      baseUrl = normalizeBaseUrl(await terminal.question('ERP 地址: '));
    } finally {
      terminal.close();
    }
  }
  let username = String(options.username || process.env.NEW_ERP_USERNAME || '').trim();
  let password = process.env.NEW_ERP_PASSWORD;
  if (!password) ({ username, password } = await promptCredentials(username));
  username = requiredString(username, 'username');
  password = requiredString(password, 'password');
  const session = await withErpContext({ baseUrl }, () => loginToken({ username, password }));
  const sessionFile = saveSession({ baseUrl, ...session });
  return { baseUrl, username: session.username, userId: session.userId,
    expireTime: session.expireTime, sessionFile, loggedIn: true };
}

module.exports = { main };
if (require.main === module) runCli({ name: 'login', description: '登录自己的 ERP 账号，仅在本机保存 token，不保存密码。',
  args: [
    { name: 'browser', type: 'bool', default: false, help: '打开本机临时网页，一次填写 ERP 网址、账号和密码' },
    { name: 'open', type: 'bool', default: true, help: '浏览器模式自动打开页面；设为 false 时只显示登录链接' },
    { name: 'baseUrl', type: 'string', help: 'ERP 地址；首次登录未配置时在终端提示输入，也可配置 NEW_ERP_BASE_URL' },
    { name: 'username', type: 'string', help: 'ERP 账号；留空时交互输入，也可用 NEW_ERP_USERNAME' },
  ], func: main });
