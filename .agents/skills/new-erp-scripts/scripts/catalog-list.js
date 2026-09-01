const {
  ArgumentError,
  EmptyResultError,
  getBaseUrl,
  getTokenFromArgs,
  loginToken,
  requestJson,
  runCli,
} = require('./shared.js');

function asNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseIdSet(value, label) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ids = text
    .split(/[\s,，;；|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.some((id) => !/^\d+$/.test(id))) {
    throw new ArgumentError(`${label} must be numeric id list, separated by comma/space`);
  }
  return new Set(ids);
}

async function resolveToken(args) {
  const existingToken = getTokenFromArgs(args);
  if (existingToken) return existingToken;
  const session = await loginToken(args);
  return session.token;
}

function flattenCatalog(nodes, parentNames = []) {
  const rows = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const children = Array.isArray(node?.son) ? node.son : [];
    const nameCn = String(node?.name_cn ?? '').trim();
    const fullName = [...parentNames, nameCn].filter(Boolean).join(' / ');
    const shallowNode = { ...node };
    delete shallowNode.son;
    rows.push({
      id: String(node?.id ?? '').trim() || null,
      nameCn: nameCn || null,
      fullName: fullName || null,
      parentId: String(node?.parent ?? '').trim() || null,
      path: String(node?.path ?? '').trim() || null,
      level: parentNames.length + 1,
      isGame: String(node?.is_game ?? '').trim() || null,
      status: String(node?.status ?? '').trim() || null,
      productSkuCount: asNumberOrNull(node?.productSkuCount),
      hasChildren: children.length > 0,
      childrenIds: children
        .map((child) => String(child?.id ?? '').trim())
        .filter(Boolean)
        .join(','),
      rawNode: shallowNode,
    });
    rows.push(...flattenCatalog(children, [...parentNames, nameCn]));
  }
  return rows;
}

function filterRows(rows, args) {
  const idSet = parseIdSet(args.id, 'id');
  const parentSet = parseIdSet(args.parentId, 'parentId');
  const keyword = String(args.keyword ?? '').trim().toLowerCase();
  const onlyWithProducts = Boolean(args.onlyWithProducts);

  return rows.filter((row) => {
    if (idSet && !idSet.has(String(row.id))) return false;
    if (parentSet && !parentSet.has(String(row.parentId))) return false;
    if (onlyWithProducts && !(Number(row.productSkuCount) > 0)) return false;
    if (keyword) {
      const haystack = [row.id, row.nameCn, row.fullName, row.path]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

function outputRow(row, includeRaw) {
  return {
    id: row.id,
    nameCn: row.nameCn,
    fullName: row.fullName,
    parentId: row.parentId,
    path: row.path,
    level: row.level,
    isGame: row.isGame,
    status: row.status,
    productSkuCount: row.productSkuCount,
    hasChildren: row.hasChildren,
    childrenIds: row.childrenIds,
    rawJson: includeRaw ? JSON.stringify(row.rawNode) : null,
  };
}

const args = [
  { name: 'id', type: 'string', default: '', help: '按类目 ID 过滤，多个用逗号/空格分隔' },
  { name: 'parentId', type: 'string', default: '', help: '按父类目 ID 过滤，多个用逗号/空格分隔' },
  { name: 'keyword', type: 'string', default: '', help: '按 id/nameCn/fullName/path 模糊搜索' },
  { name: 'onlyWithProducts', type: 'bool', default: false, help: '只返回 productSkuCount > 0 的类目' },
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
  { name: 'raw', type: 'bool', default: false, help: '附带原始类目 JSON' },
];

async function main(argsValue) {
  const token = await resolveToken(argsValue);
  const url = new URL(`${getBaseUrl()}/index.php`);
  url.searchParams.set('r', '/products/game-product-list/selected-options');

  const json = await requestJson(url.href, {
    label: 'new-erp catalog-list selected-options',
    headers: { token },
  });

  const rows = flattenCatalog(json?.data?.catalog_list);
  const filtered = filterRows(rows, argsValue);
  if (filtered.length === 0) {
    throw new EmptyResultError('new-erp catalog-list', 'No categories matched selected-options filters');
  }
  return filtered.map((row) => outputRow(row, Boolean(argsValue.raw)));
}

if (require.main === module) {
  runCli({
    name: 'catalog-list',
    description: '获取并展开 new-erp 产品类目。',
    args,
    func: main,
  });
}
