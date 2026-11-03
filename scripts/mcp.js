#!/usr/bin/env node
const { z } = require('zod/v4');
const { parseArgs, formatHelp, redactSensitiveText } = require('./shared.js');
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
  message: '先调用 erp_execute，operation 为 auth.login，params 为 {}。把返回的本机网页链接交给用户，由用户一次填写 ERP 网址、账号和密码；Agent 不查看或填写密码。登录后重试原查询，无需重启 MCP。',
  next: { tool: 'erp_execute', arguments: { operation: 'auth.login', params: {} } },
  fallback: '网页不可用时可在本机运行 new-erp login --browser；也可用客户端 request_secret 私密输入或让用户在终端运行 new-erp login --baseUrl <ERP_URL>。不得在对话、工具参数、命令参数或日志中传递密码和 token。',
};

function response(output, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(output) }], ...(isError ? { isError: true } : {}) };
}

async function createServer(options = {}) {
  const { McpServer } = await import('@modelcontextprotocol/server');
  const auth = createAuth({ openBrowser: options.openBrowser, browserTimeoutMs: options.browserTimeoutMs });
  const jobs = createJobs({ rootDir: options.rootDir, getOperation: catalog.getOperation, waitMs: options.waitMs });
  const server = new McpServer({ name: 'new-erp', version }, {
    instructions: '先发现能力和参数，再执行；业务使用本机 ERP 会话。',
  });

  async function answer(operation, redact = true) {
    try {
      const output = await operation();
      return response(output?.error?.code === 'LOGIN_REQUIRED' ? { ...output, error: loginGuide } : output,
        output?.state === 'failed' || output?.state === 'interrupted');
    } catch (error) {
      if (error.code === 'LOGIN_REQUIRED') return response({ error: loginGuide }, true);
      const message = error.issues
        ? error.issues.map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; ')
        : error.message || 'ERP 操作失败';
      return response({ error: { code: error.code || 'INVALID_CALL', message: (redact ? redactSensitiveText(message) : message).slice(0, 1200) } }, true);
    }
  }

  server.registerTool('erp_discover', {
    description: '按关键词查找 ERP 能力；指定 operation 获取该项参数。',
    inputSchema: z.strictObject({ query: z.string().trim().max(200).optional(), operation: z.string().trim().max(100).optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => answer(() => {
    if (input.operation) {
      if (input.query) throw new Error('query 与 operation 二选一');
      const helper = helpers.get(input.operation);
      return helper ? { name: input.operation, description: helper.description,
        inputSchema: z.toJSONSchema(helper.schema, { io: 'input' }) } : catalog.describeOperation(input.operation);
    }
    const words = (input.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const internal = [...helpers].filter(([name, helper]) => words.every((word) => `${name} ${helper.description}`.toLowerCase().includes(word)))
      .map(([name, helper]) => ({ name, description: helper.description, effect: name === 'auth.login' || name === 'auth.logout' || name === 'jobs.resume' || name === 'jobs.cancel' ? 'local' : 'read' }));
    return { operations: [...catalog.listOperations(input.query || ''), ...internal] };
  }, false));

  server.registerTool('erp_execute', {
    description: '执行已发现的能力；导出需稳定 requestId，任务通过 jobs.status 查询。',
    inputSchema: z.strictObject({ operation: z.string().trim().min(1).max(100),
      params: z.record(z.string(), z.unknown()).default({}), requestId: z.string().min(1).max(128).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input) => answer(async () => {
    if (Buffer.byteLength(JSON.stringify(input.params)) > 64 * 1024) throw new Error('参数超过 64 KiB，请缩小查询范围');
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
  server.close = async () => { await auth.close(); await jobs.close(); await closeServer(); };
  return server;
}

const definition = { name: 'mcp', description: '启动按需发现和执行 ERP 能力的本地 stdio MCP。', args: [] };
async function main() {
  const args = parseArgs(process.argv.slice(2), []);
  if (args.help) { process.stdout.write(formatHelp(definition)); return; }
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
