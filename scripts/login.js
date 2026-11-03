#!/usr/bin/env node
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { ArgumentError, getBaseUrl, loginToken, normalizeBaseUrl, requiredString, runCli,
  withErpContext } = require('./shared.js');
const { saveSession } = require('./local-session.js');

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
  const baseUrl = options.baseUrl ? normalizeBaseUrl(options.baseUrl) : getBaseUrl();
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
    { name: 'baseUrl', type: 'string', help: 'ERP 地址；首次登录必填，也可配置 NEW_ERP_BASE_URL' },
    { name: 'username', type: 'string', help: 'ERP 账号；留空时交互输入，也可用 NEW_ERP_USERNAME' },
  ], func: main });
