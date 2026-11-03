#!/usr/bin/env node
const { runCli } = require('./shared.js');
const { removeSession } = require('./local-session.js');
async function main() {
  removeSession();
  return { loggedOut: true };
}
module.exports = { main };
if (require.main === module) runCli({ name: 'logout', description: '删除本机保存的 ERP 登录会话；不修改环境变量或项目配置。', args: [], func: main });
