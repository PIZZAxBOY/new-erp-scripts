const { z } = require('zod');

const hiddenArgs = new Set(['username', 'password', 'token', 'output']);
const registry = new Map([
  ['market_order_list', { name: 'market_order_list', description: '查询市场订单与订单原始字段', effect: 'read', script: 'market-order-list.js' }],
  ['catalog_list', { name: 'catalog_list', description: '查找商品分类与分类 ID', effect: 'read', script: 'catalog-list.js' }],
  ['category_summary', { name: 'category_summary', description: '按分类统计 SKU 记录行数，不是销量或排名；自动抓取全部分页，成本高', effect: 'read', script: 'category-summary.js', keywords: ['分类', '类目', '计数', '记录数', '行数', '销售记录', 'sku记录', 'category', 'count'] }],
  ['game_product_batch', { name: 'game_product_batch', description: '批量查询多个商品 SKU', effect: 'read', script: 'game-product-batch.js' }],
  ['game_product_list', { name: 'game_product_list', description: '按 SKU、名称或分类搜索商品', effect: 'read', script: 'game-product-list.js' }],
  ['product_detail', { name: 'product_detail', description: '按商品 ID 或 ASIN 查询 ERP 商品详情与图片', effect: 'read', script: 'product-detail.js' }],
  ['product_images', { name: 'product_images', description: '按精确 SKU 查询 ERP 完整图集：橱窗图、小图、包装图、宣传图、样品图', effect: 'read', script: 'product-images.js' }],
  ['sales_volume_ranking', { name: 'sales_volume_ranking', description: '查询 SKU 销量/销售排名、热销 Top N；默认顶级物料，异步导出 CSV 后排名，需 requestId', effect: 'export', script: 'sales-volume-ranking.js', keywords: ['销售', '销量', '排名', '排行', '热销', 'top', 'sku', 'sales', 'ranking'],
    examples: [{ description: 'JY 顶级物料销量前 10 名；完整导出后排序，轮询同一任务，不先查分类', operation: 'sales_volume_ranking', requestId: 'jy-sales-2026-10-top10', params: { source: 'export', startDate: '2026-10-01', endDate: '2026-10-31', auctionSite: 'JY', productTypeCate: '5', page: 1, pageSize: 10, fetchAll: false, sort: 'sales', order: 'desc' } }],
  }],
  ['sales_volume_export', { name: 'sales_volume_export', description: '异步导出销量 CSV；需要文件时使用，不用于快速 Top N 查询', effect: 'export', script: 'sales-volume-export.js', keywords: ['销售', '销量', '导出', 'csv', 'export'] }],
  ['supply_evidence', { name: 'supply_evidence', description: '查询计划、库存及货物流转凭证', effect: 'read', script: 'supply-evidence.js' }],
  ['stocking_assembly_inbound', { name: 'stocking_assembly_inbound', description: '统计备货拼装的实际入库数量', effect: 'read', script: 'stocking-assembly-inbound.js' }],
  ['packing_order_list', { name: 'packing_order_list', description: '查询装箱单列表', effect: 'read', script: 'packing-order-list.js' }],
  ['packing_order_pages', { name: 'packing_order_pages', description: '逐页读取装箱记录并输出 NDJSON', effect: 'stream', script: 'packing-order-list.js', method: 'pages', omitArgs: ['fetchAll'] }],
  ['packing_detail', { name: 'packing_detail', description: '查询单箱明细', effect: 'read', script: 'packing-detail.js' }],
  ['plan_delivery_order_list', { name: 'plan_delivery_order_list', description: '查询历史配货明细', effect: 'read', script: 'plan-delivery-order-list.js' }],
  ['packing_detail_export', { name: 'packing_detail_export', description: '导出装箱明细 XLSX', effect: 'export', script: 'packing-detail-export.js' }],
  ['packing_batch_list', { name: 'packing_batch_list', description: '查询配货批次', effect: 'read', script: 'packing-batch-list.js' }],
  ['packing_batch_detail', { name: 'packing_batch_detail', description: '查询配货批次的 SKU 与 BOM 明细', effect: 'read', script: 'packing-batch-detail.js' }],
  ['outer_package_list', { name: 'outer_package_list', description: '查询外包装规格与版本', effect: 'read', script: 'outer-package-list.js' }],
  ['inventory_list', { name: 'inventory_list', description: '查询库存批次或仓库汇总', effect: 'read', script: 'inventory-list.js' }],
  ['logistics_channel_list', { name: 'logistics_channel_list', description: '查询物流渠道与运输方式', effect: 'read', script: 'logistics-channel-list.js' }],
  ['product_declaration_list', { name: 'product_declaration_list', description: '查询商品申报主数据', effect: 'read', script: 'product-declaration-list.js' }],
  ['erp_options', { name: 'erp_options', description: '读取实时仓库、状态等枚举', effect: 'read', script: 'erp-options.js' }],
]);

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
  const normalized = query.trim().toLowerCase();
  if (registry.has(normalized)) return [summary(registry.get(normalized))];
  const words = normalized.split(/\s+/).filter(Boolean);
  return [...registry.values()].map((entry) => {
    const keywords = entry.keywords || [];
    const text = `${entry.name} ${entry.description} ${keywords.join(' ')}`.toLowerCase();
    const matches = words.every((word) => text.includes(word));
    const relevance = words.filter((word) => keywords.includes(word)).length;
    return { entry, matches, relevance };
  }).filter(({ matches }) => matches)
    .sort((a, b) => b.relevance - a.relevance)
    .map(({ entry }) => summary(entry));
}

function entryFor(name) {
  const entry = registry.get(name);
  if (!entry) throw new Error('Unknown ERP operation');
  return entry;
}

function metadata(entry) {
  if (entry.api) return { schema: entry.schema, args: [] };
  const implementation = require(`./${entry.script}`);
  const args = implementation.args.filter((arg) => !hiddenArgs.has(arg.name) && !entry.omitArgs?.includes(arg.name));
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
  if (entry.effect === 'export') requirements.push(entry.name === 'sales_volume_ranking'
    ? 'Requires a stable requestId (also for source=list). Returns ranking data; poll jobs.status with the same jobId. CSV is parsed in memory, not saved as an artifact.'
    : 'Requires a stable requestId. Files are saved to a server-managed private artifact.');
  if (entry.name === 'sales_volume_ranking') requirements.push('远程 HTTP export 默认使用不自动过期的完整销量快照；返回 localData 覆盖信息和 cache.permanent。仅已验证的 JY 顶级 SKU 月度范围、sort=sales/sku 且无 SKU/平台/分类筛选可组合片段并只导出缺口，其他查询仅精确复用。localData 时间是下载时间，不代表 ERP 快照时间；forceRefresh=true 配新 requestId 使重叠覆盖失效并重新导出，同一 requestId 始终复用原任务。salesData.enabled=false 时退回 15 分钟 salesCache；两者都禁用才每次重新导出。source=list、JS/stdio 不使用共享层。权限变化须同时更新 salesData.epoch 和 salesCache.epoch。');
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
    category_summary: '仅统计各分类 SKU 销售记录行数，不累计销售件数，也不是 SKU 销量排名。无论 pageSize 多小都会读取全部匹配分页（默认每页 100 条、最多 100 页）；没有 Top N 或单页模式。仅在明确需要分类记录计数时使用；查询销量、热销或前 N 名请直接用 sales_volume_ranking，不要先运行此工具。',
    sales_volume_ranking: '销量/热销/Top N 首选此工具，不需要先查 category_summary。startDate/endDate 必填；默认 productTypeCate="5"（顶级物料），显式 "6" 查询二级物料，显式 "" 查询全部类型。默认 source=export：只提交一次异步导出，等待下载完整 CSV 后排序；Top N（N<=100）用 page=1、pageSize=N、fetchAll=false 截取结果，不减少上游导出量。fetchAll=true 返回全部排名，指定 sku 时精确过滤并返回全部匹配结果。长时间范围不要先调用列表接口；异步导出仍可能排队或失败，最长等待约20分钟，CSV上限64MiB，不能保证耗时。可显式 source=list 使用旧列表模式：单页仅支持销量降序，其他排序或 sku 查询需完整分页，maxPages 仅限制 list。MCP 用稳定 requestId 提交并轮询同一 jobId，勿反复创建任务。不猜测缺失销量、未知 CSV 表头或 mean 口径。',
    sales_volume_export: '需要 CSV 文件时使用，会创建 ERP 异步导出任务，不是低成本 Top N 查询；快速销量排名请用 sales_volume_ranking。此工具没有 productTypeCate 参数，不继承销量排名默认顶级物料的筛选。',
    game_product_list: 'ERP 搜索可能模糊匹配，需核对返回 SKU；结果仅为当前页。',
    game_product_batch: 'found 表示 ERP 搜索有返回，不保证精确 SKU；每个 SKU 只查一页，结合 querySku 和 totalCount 判断范围。',
    product_detail: 'id 与 asin 必须二选一。ASIN 保留全部精确 SKU 和店铺匹配；imageUrl 返回完整 HTTP(S) 主图地址，无图为 null，不保证有完整图库。',
    product_images: 'sku 必填且精确匹配。读取图片管理页六组图集，保留包装版本和主图标记，返回完整 HTTP(S) 地址。任一组失败则整体失败；complete 仅指这六组接口响应完整，不保证图片匿名可访问或覆盖其他业务页面。',
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
  return { ...summary(entry), inputSchema, requirements: requirementsFor(entry, args), execution: 'job',
    ...(entry.examples ? { examples: entry.examples } : {}) };
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
        if (['packing_detail_export', 'sales_volume_ranking'].includes(entry.name)) options.onProgress = hooks.onProgress;
      }
      return implementation[entry.method || (entry.effect === 'stream' ? 'pages' : 'main')](options);
    },
  };
}

module.exports = { listOperations, describeOperation, getOperation };
