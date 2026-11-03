#!/usr/bin/env node
const { z } = require('zod/v4');
const { AuthRequiredError, parseArgs, formatHelp, redactSensitiveText, withErpContext } = require('./shared.js');
const { readSession, sessionExpired } = require('./local-session.js');
const { version } = require('../package.json');

async function createServer() {
  const { McpServer } = await import('@modelcontextprotocol/server');
  const api = await import('../index.mjs');
  const server = new McpServer({ name: 'new-erp', version }, {
    instructions: 'All tools query ERP using the current OS user\'s saved login. If login is missing or expired, ask the user to run new-erp login in their own terminal. Never ask for passwords or tokens in tool arguments. Inventory forecasts are not received stock; preserve batches and BOM versions.',
  });
  const page = z.number().int().min(1).default(1).describe('页码，每次调用仅查询一页');
  const pageSize = z.number().int().min(1).max(100).default(20).describe('每页记录数，最多100');
  const tools = [
    {
      name: 'game_product_list', description: '按 SKU、中文品名或分类查询 ERP 商品及图片链接。搜索可能模糊匹配，需核对返回的 SKU。返回当前一页，totalCount 在各行中。',
      schema: z.strictObject({
        sku: z.string().trim().optional().describe('SKU 搜索关键字'),
        nameCn: z.string().trim().optional().describe('中文品名关键字'),
        catalogId: z.string().trim().optional().describe('类目 ID，多个用逗号分隔'),
        productTypeCate: z.enum(['1', '4', '5', '6']).optional(), page, pageSize,
      }),
      run: api.gameProductList,
    },
    {
      name: 'product_detail', description: '按 ERP 产品基础 ID 或 ASIN 查询商品详情、ERP 图片和全部 SKU/BOM 版本。id 与 asin 必须二选一。ASIN 先查询 ERP Listing 再按匹配的 SKU 获取详情，保留多个店铺和商品匹配，所有查询需登录。',
      schema: z.strictObject({
        id: z.number().int().positive().optional().describe('ERP 产品基础 ID，与 asin 二选一'),
        asin: z.string().trim().regex(/^[a-zA-Z0-9]{10}$/).optional().describe('10位 ASIN，在 ERP 中搜索，与 id 二选一'),
        maxPages: z.number().int().min(1).max(1000).default(100).describe('ASIN 和 SKU 查询各自最多读取的页数，每页100条'),
      }).refine((input) => (input.id !== undefined) !== (input.asin !== undefined), 'Provide exactly one of id or asin'),
      run: api.productDetail,
    },
    {
      name: 'inventory_list', description: '按精确 SKU 和仓库代码查询国内仓库存。默认保留批次/BOM。预计可用不代表已签收库存。仓库代码可用 erp_options 查询。',
      schema: z.strictObject({ sku: z.string().trim().min(1), stockCode: z.string().trim().min(1),
        groupBy: z.enum(['batch', 'warehouse']).default('batch'), page, pageSize }),
      run: api.inventoryList,
    },
    {
      name: 'erp_options', description: '读取 ERP 实时仓库、状态和渠道枚举，不推断代码含义。',
      schema: z.strictObject({ source: z.enum(['inventory', 'packing', 'batchWarehouses']) }),
      run: api.erpOptions,
    },
  ];
  for (const tool of tools) {
    server.registerTool(tool.name, {
      description: tool.description, inputSchema: tool.schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (input) => {
      let session;
      try {
        session = readSession();
        if (!session || sessionExpired(session)) throw new AuthRequiredError('local session', 'Run new-erp login first; ERP session is missing or expired');
        const result = await withErpContext(session, () => tool.run(input));
        const output = Array.isArray(result) ? { list: result } : result;
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        const message = error instanceof AuthRequiredError ? 'ERP 登录失效或尚未登录，请在自己的终端运行 new-erp login' : error.message || 'ERP query failed';
        return { isError: true, content: [{ type: 'text', text: redactSensitiveText(message, [session?.token, session?.username]) }] };
      }
    });
  }
  return server;
}

const definition = { name: 'mcp', description: '启动本地 stdio MCP。标准输出仅用于协议；ERP 查询需先运行 new-erp login。', args: [] };
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
