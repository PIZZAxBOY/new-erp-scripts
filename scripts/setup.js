#!/usr/bin/env node
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ArgumentError, CommandExecutionError, runCli } = require('./shared.js');

async function main({ client = 'codex', name = 'new-erp', dryRun = false } = {}) {
  if (client !== 'codex') throw new ArgumentError('client must be codex');
  if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new ArgumentError('name must start with a letter and contain only letters, digits, _ or -');
  }
  const args = ['mcp', 'add', name, '--', process.execPath, path.join(__dirname, 'mcp.js')];
  if (dryRun) return { command: 'codex', args };
  const env = { ...process.env };
  for (const key of ['NEW_ERP_TOKEN', 'NEW_ERP_USERNAME', 'NEW_ERP_PASSWORD']) delete env[key];
  // PowerShell resolves npm's codex.cmd on Windows without interpolating arguments into shell code.
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$erpCodexArgs = ConvertFrom-Json $env:NEW_ERP_CODEX_ARGS; & codex @erpCodexArgs; exit $LASTEXITCODE'],
    { encoding: 'utf8', env: { ...env, NEW_ERP_CODEX_ARGS: JSON.stringify(args) } })
    : spawnSync('codex', args, { encoding: 'utf8', env });
  if (result.error || result.status !== 0) {
    throw new CommandExecutionError('Cannot register MCP with Codex; install Codex CLI, then retry new-erp setup --client codex');
  }
  return { client, name, configured: true, message: 'Restart Codex to load the new-erp MCP tools. ERP queries require new-erp login.' };
}

module.exports = { main };
if (require.main === module) runCli({ name: 'setup', description: '将本机安装的 MCP 注册到 Codex；重新运行可更新同名配置。',
  args: [
    { name: 'client', type: 'string', default: 'codex', help: '目标客户端，目前支持 codex' },
    { name: 'name', type: 'string', default: 'new-erp', help: 'Codex 中的 MCP 名称；会替换同名配置' },
    { name: 'dryRun', type: 'bool', default: false, help: '仅展示注册命令，不修改 Codex 配置' },
  ], func: main });
