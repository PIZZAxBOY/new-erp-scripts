const { z } = require('zod');
const { commands } = require('./new-erp.js');

const hiddenArgs = new Set(['username', 'password', 'token', 'output']);
const registry = new Map();
for (const [cliName, command] of Object.entries(commands)) {
  if (!['read', 'export', 'stream', 'local'].includes(command.kind)) {
    throw new Error(`Command must declare a supported kind: ${cliName}`);
  }
  if (command.kind === 'local') continue;
  const name = cliName === 'options' ? 'erp_options' : cliName.replaceAll('-', '_');
  registry.set(name, { name, description: command.description, effect: command.kind, script: command.script });
}

registry.set('export_game_products', {
  name: 'export_game_products', description: '导出在用或停用商品 XLSX', effect: 'export',
  api: 'exportGameProducts',
  schema: z.strictObject({
    fields: z.array(z.string().trim().min(1)).min(1)
      .refine((fields) => new Set(fields).size === fields.length, 'fields must be unique')
      .default(['sku', 'name_cn', 'price']).describe('ERP 导出字段名；非空且不重复'),
    disused: z.boolean().default(false).describe('导出停用商品'),
  }),
});
registry.set('export_outer_packages', {
  name: 'export_outer_packages', description: '导出外包装规格 XLSX', effect: 'export',
  api: 'exportOuterPackages',
  schema: z.strictObject({
    flowStatus: z.union([z.enum(['1', '2', '3', '4', '5']), z.number().int().min(1).max(5)])
      .describe('外包装流程状态，1–5'),
  }),
});

function summary(entry) {
  return { name: entry.name, description: entry.description, effect: entry.effect };
}

function listOperations(query = '') {
  if (typeof query !== 'string') throw new TypeError('query must be a string');
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return [...registry.values()].filter((entry) =>
    words.every((word) => `${entry.name} ${entry.description}`.toLowerCase().includes(word))).map(summary);
}

function entryFor(name) {
  const entry = registry.get(name);
  if (!entry) throw new Error('Unknown ERP operation');
  return entry;
}

function metadata(entry) {
  if (entry.api) return { schema: entry.schema, args: [] };
  const implementation = require(`./${entry.script}`);
  const args = implementation.args.filter((arg) => !hiddenArgs.has(arg.name));
  const shape = {};
  for (const arg of args) {
    let field;
    if (arg.type === 'string') field = z.string();
    else if (arg.type === 'int') field = z.number().int();
    else if (arg.type === 'bool') field = z.boolean();
    else throw new Error(`Unsupported argument type: ${arg.type}`);
    field = arg.default === undefined ? field.optional() : field.default(arg.default);
    shape[arg.name] = field.describe(arg.help);
  }
  return { schema: z.strictObject(shape), args };
}

function requirementsFor(entry, args) {
  const requirements = ['Requires a fresh saved personal ERP login. Business validators enforce required filters and valid values.'];
  if (entry.effect === 'export') requirements.push('Requires a stable requestId. Files are saved to a server-managed private artifact.');
  for (const arg of args.filter((field) => field.choices)) {
    requirements.push(`${arg.name}: ${arg.choices.join(', ')} (runtime aliases may also be accepted)`);
  }
  if (entry.name.startsWith('packing_order_')) {
    requirements.push('Supply packingNo alone, or all of project, warehouses, startDate, endDate. Supplying any historical field requires all four.');
  }
  if (entry.name === 'packing_detail_export') {
    requirements.push('project, warehouses, startDate, endDate are always required. taskId resumes only a matching existing ERP export.');
  }
  if (entry.name === 'export_game_products') requirements.push('fields accepts nonempty unique ERP field names; the three defaults are examples, not an allowlist.');
  const scope = {
    game_product_list: 'ERP 搜索可能模糊匹配，需核对返回 SKU；结果仅为当前页。',
    game_product_batch: 'found 表示 ERP 搜索有返回，不保证精确 SKU；每个 SKU 只查一页，结合 querySku 和 totalCount 判断范围。',
    product_detail: 'id 与 asin 必须二选一。ASIN 保留全部精确 SKU 和店铺匹配；imageUrl 是 ERP 原始路径，不保证有完整图库。',
    inventory_list: '预计可用不代表实际签收；保留不同批次、BOM，不自动合并为单一版本。',
    supply_evidence: '计划不是完成凭证；数组不带分页完整性元数据，不推断全量。需要完整范围时显式使用 fetchAll。',
    stocking_assembly_inbound: '仅统计精确 SKU 关联的备货拼装实际入库凭证，不以计划量或预测库存代替。',
    packing_detail: '保留全部 SKU、BOM、包装版本和原始单位，不自动选择首个版本或猜测单位。',
    outer_package_list: '保留不同包装规格及 BOM 版本，不自动选择首条或把未知数量补零。',
    product_declaration_list: 'SKU 筛选可能模糊匹配，需核对返回的 SKU 与国家。',
  };
  if (scope[entry.name]) requirements.push(scope[entry.name]);
  return requirements;
}

function describeOperation(name) {
  const entry = entryFor(name);
  const { schema, args } = metadata(entry);
  const inputSchema = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return { ...summary(entry), inputSchema, requirements: requirementsFor(entry, args), execution: 'job' };
}

function getOperation(name) {
  const entry = entryFor(name);
  const { schema } = metadata(entry);
  return {
    ...summary(entry), schema,
    invoke(params = {}, hooks = {}) {
      const options = schema.parse(params);
      if (entry.api) return import('../index.mjs').then((api) => api[entry.api](options));
      const implementation = require(`./${entry.script}`);
      if (entry.effect === 'export') {
        if (typeof hooks.outputPath !== 'string' || !hooks.outputPath.trim()) {
          throw new TypeError('Export requires a server-owned outputPath');
        }
        options.output = hooks.outputPath;
        if (entry.name === 'packing_detail_export') options.onProgress = hooks.onProgress;
      }
      return implementation[entry.effect === 'stream' ? 'pages' : 'main'](options);
    },
  };
}

module.exports = { listOperations, describeOperation, getOperation };
