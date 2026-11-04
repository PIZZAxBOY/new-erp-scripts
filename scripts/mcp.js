#!/usr/bin/env node
const { z } = require('zod/v4');
const { redactSensitiveText } = require('./shared.js');
const { createAuth } = require('./mcp-auth.js');
const catalog = require('./mcp-catalog.js');
const { createJobs } = require('./mcp-jobs.js');
const { version } = require('../package.json');

const noParams = z.strictObject({});
const jobParams = z.strictObject({ jobId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const helpers = new Map([
  ['auth.login', { description: '打开本机临时网页登录，一次填写 ERP 网址、账号和密码', schema: noParams }],
  ['auth.status', { description: '查看本机登录状态，不返回密码或 token', schema: noParams }],
  ['auth.logout', { description: '取消待完成登录并删除本机会话', schema: noParams }],
  ['jobs.status', { description: '读取当前账号的任务状态、结果及文件路径', schema: jobParams }],
  ['jobs.list', { description: '查找当前账号的最近任务，避免重复导出', schema: z.strictObject({ limit: z.number().int().min(1).max(100).default(10) }) }],
  ['jobs.resume', { description: '用已保存的 taskId 和原查询范围恢复装箱导出，需新的 requestId', schema: jobParams }],
  ['jobs.cancel', { description: '取消排队任务；运行中的 ERP 操作不支持可靠取消', schema: jobParams }],
]);

const loginGuide = {
  code: 'LOGIN_REQUIRED',
  message: '调用 erp_execute，operation 为 auth.login，params 为 {}。把返回的本机网页链接交给用户，由用户在网页中填写 ERP 网址、账号和密码；Agent 不查看或填写密码。登录后重试原查询，无需重启 MCP。登录页面过期时再次调用 auth.login。',
  next: { tool: 'erp_execute', arguments: { operation: 'auth.login', params: {} } },
};
const remoteLoginGuide = {
  code: 'LOGIN_REQUIRED',
  message: '此服务的 ERP 会话需要管理员处理。请联系服务管理员重新验证会话；不要通过 MCP 提交 ERP 凭据。',
};
const remoteAuthManagement = new Set(['auth.login', 'auth.logout']);

function helperDescription(name, helper, remote) {
  if (!remote) return helper.description;
  if (name === 'auth.status') return '查看服务 ERP 会话状态，不返回账号或凭据';
  if (name === 'jobs.status') return '读取任务状态、结果及受保护的文件下载链接';
  if (name === 'jobs.list') return '查找最近任务及其受保护的文件下载链接';
  return helper.description;
}

function remoteAuthManagementError() {
  return Object.assign(new Error('ERP 会话由服务管理员管理；请联系管理员处理登录。'), {
    code: 'REMOTE_AUTH_MANAGEMENT_DISABLED',
  });
}

function sanitizeRemoteOutput(value) {
  if (Array.isArray(value)) return value.map(sanitizeRemoteOutput);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'error' && item && typeof item === 'object') {
      output[key] = item.code === 'LOGIN_REQUIRED'
        ? remoteLoginGuide
        : { code: item.code || 'EXECUTION_FAILED', message: '远程操作失败；请联系服务管理员检查服务状态。' };
    } else output[key] = sanitizeRemoteOutput(item);
  }
  return output;
}

function response(output, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(output) }], ...(isError ? { isError: true } : {}) };
}

async function createServer(options = {}) {
  const { McpServer } = await import('@modelcontextprotocol/server');
  const ownsAuth = !options.auth;
  const ownsJobs = !options.jobs;
  const auth = options.auth || createAuth({ openBrowser: options.openBrowser, browserTimeoutMs: options.browserTimeoutMs });
  const jobs = options.jobs || createJobs({ rootDir: options.rootDir, getOperation: catalog.getOperation, waitMs: options.waitMs });
  const server = new McpServer({ name: 'new-erp', version }, {
    instructions: options.remote
      ? '先发现能力和参数，再执行；ERP 会话由服务管理员管理。'
      : '先发现能力和参数，再执行；业务使用本机 ERP 会话。',
  });

  async function answer(operation, redact = true) {
    try {
      let output = await operation();
      if (output?.error?.code === 'LOGIN_REQUIRED') {
        output = { ...output, error: options.remote ? remoteLoginGuide : loginGuide };
      }
      if (options.remote) output = sanitizeRemoteOutput(output);
      if (options.transformOutput) output = await options.transformOutput(output);
      return response(output, output?.state === 'failed' || output?.state === 'interrupted');
    } catch (error) {
      if (error.code === 'LOGIN_REQUIRED') return response({ error: options.remote ? remoteLoginGuide : loginGuide }, true);
      if (error.code === 'REMOTE_AUTH_MANAGEMENT_DISABLED') {
        return response({ error: { code: error.code, message: error.message } }, true);
      }
      const message = error.issues
        ? error.issues.map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; ')
        : options.remote ? '远程操作失败；请联系服务管理员检查服务状态。' : error.message || 'ERP 操作失败';
      return response({ error: { code: error.code || 'INVALID_CALL', message: (redact ? redactSensitiveText(message) : message).slice(0, 1200) } }, true);
    }
  }

  server.registerTool('erp_discover', {
    description: '按关键词查找 ERP 能力（如销售、销量、排名、热销）；指定 operation 获取参数、成本提示和示例。',
    inputSchema: z.strictObject({ query: z.string().trim().max(200).optional(), operation: z.string().trim().max(100).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => answer(() => {
      if (input.operation) {
        if (input.query) throw new Error('query 与 operation 二选一');
        if (options.remote && remoteAuthManagement.has(input.operation)) throw remoteAuthManagementError();
        const helper = helpers.get(input.operation);
      if (helper) return { name: input.operation, description: helperDescription(input.operation, helper, options.remote),
        inputSchema: z.toJSONSchema(helper.schema, { io: 'input' }) };
      const description = catalog.describeOperation(input.operation);
      if (!options.remote) return description;
      return {
        ...description,
        requirements: description.requirements.map(requirement => requirement.startsWith('Requires a fresh saved personal ERP login.')
          ? 'Requires an active ERP session configured by the service administrator. Business validators enforce required filters and valid values.'
          : requirement),
      };
    }
    const words = (input.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const internal = [...helpers]
      .filter(([name]) => !options.remote || !remoteAuthManagement.has(name))
      .filter(([name, helper]) => words.every((word) => `${name} ${helperDescription(name, helper, options.remote)}`.toLowerCase().includes(word)))
      .map(([name, helper]) => ({ name, description: helperDescription(name, helper, options.remote),
        effect: name === 'auth.login' || name === 'auth.logout' || name === 'jobs.resume' || name === 'jobs.cancel' ? 'local' : 'read' }));
    return { operations: [...catalog.listOperations(input.query || ''), ...internal] };
  }, false));

  server.registerTool('erp_execute', {
    description: '执行已发现的能力；导出需稳定 requestId，任务通过 jobs.status 查询。',
    inputSchema: z.strictObject({ operation: z.string().trim().min(1).max(100),
      params: z.record(z.string(), z.unknown()).default({}), requestId: z.string().min(1).max(128).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input) => answer(async () => {
    if (Buffer.byteLength(JSON.stringify(input.params)) > 64 * 1024) throw new Error('参数超过 64 KiB，请缩小查询范围');
    if (options.remote && remoteAuthManagement.has(input.operation)) throw remoteAuthManagementError();
    const helper = helpers.get(input.operation);
    if (helper) {
      const params = helper.schema.parse(input.params);
      if (input.operation === 'auth.login') return auth.login();
      if (input.operation === 'auth.status') return auth.status();
      if (input.operation === 'auth.logout') return auth.logout();
      const session = auth.requireSession();
      if (input.operation === 'jobs.status') return jobs.status(params.jobId, session);
      if (input.operation === 'jobs.list') return jobs.list(session, params);
      if (input.operation === 'jobs.resume') return jobs.resume(params.jobId, session, { requestId: input.requestId });
      return jobs.cancel(params.jobId, session);
    }
    const operation = catalog.getOperation(input.operation);
    const params = operation.schema.parse(input.params);
    return jobs.start(operation.name, params, auth.requireSession(), { requestId: input.requestId });
  }));

  const closeServer = server.close.bind(server);
  server.close = async () => {
    try {
      if (ownsAuth) await auth.close();
    } finally {
      try {
        if (ownsJobs) await jobs.close();
      } finally {
        await closeServer();
      }
    }
  };
  return server;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length) {
    process.stderr.write('new-erp-mcp does not accept command arguments\n');
    process.exitCode = 2;
    return;
  }
  const server = await createServer();
  const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
  const handle = serveStdio(() => server);
  process.on('SIGINT', () => { void handle.close(); });
  process.on('SIGTERM', () => { void handle.close(); });
}

module.exports = { createServer };
if (require.main === module) main().catch((error) => {
  process.stderr.write(`Error: ${redactSensitiveText(error.message)}\n`);
  process.exitCode = 1;
});
