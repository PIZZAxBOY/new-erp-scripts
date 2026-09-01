const {
  ArgumentError,
  EmptyResultError,
  expandCatalogIds,
  getBaseUrl,
  getTokenFromArgs,
  loginToken,
  positiveInteger,
  requestJson,
  requiredString,
  runCli,
} = require('./shared.js');

function parseSkus(value) {
  const raw = requiredString(value, 'skus');
  return [...new Set(raw.split(/[\s,，;；|]+/).map((item) => item.trim()).filter(Boolean))];
}

function asNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const PRODUCT_TYPE_CATE_MAP = {
  '1': '非物料',
  '4': '所有物料',
  '5': '顶级物料',
  '6': '二级物料',
};

function productTypeCateValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (PRODUCT_TYPE_CATE_MAP[text]) return text;
  const found = Object.entries(PRODUCT_TYPE_CATE_MAP).find(([, label]) => label === text);
  if (found) return found[0];
  throw new ArgumentError('productTypeCate must be one of 1/4/5/6 or 非物料/所有物料/顶级物料/二级物料');
}

async function resolveToken(args) {
  const existingToken = getTokenFromArgs(args);
  if (existingToken) return existingToken;
  const session = await loginToken(args);
  return session.token;
}

async function queryOneSku({ token, querySku, pageSize, productTypeCate, catalogId }) {
  const url = new URL(`${getBaseUrl()}/index.php`);
  url.searchParams.set('r', '/products/game-product-list/index');
  url.searchParams.set('page', '1');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('sku', querySku);
  if (productTypeCate) url.searchParams.set('product_type_cate', productTypeCate);
  if (catalogId) url.searchParams.set('catalog_id', catalogId);

  const json = await requestJson(url.href, {
    label: `new-erp game-product-batch sku=${querySku}`,
    headers: { token },
  });

  const rows = Array.isArray(json?.data?.list) ? json.data.list : [];
  if (rows.length === 0) {
    return [{
      querySku,
      found: false,
      id: null,
      sku: null,
      nameCn: null,
      productType: null,
      skuType: null,
      packVersion: null,
      bomStatus: null,
      saleStatus: null,
      developer: null,
      stockUser: null,
      price: null,
      pureWeight: null,
      totalCount: 0,
      rawJson: null,
    }];
  }

  const totalCount = Number(json?.data?.totalCount ?? rows.length);
  return rows.map((row) => {
    const skuInfo = row?.sku_info || {};
    return {
      querySku,
      found: true,
      id: row?.id ?? null,
      sku: row?.sku ?? skuInfo?.sku ?? null,
      nameCn: row?.name_cn ?? null,
      productType: skuInfo?.product_type_text ?? null,
      skuType: skuInfo?.is_3rd_sku_name ?? null,
      packVersion: skuInfo?.pack_version ?? null,
      bomStatus: skuInfo?.bom_status ?? null,
      saleStatus: row?.sale_status_text ?? row?.sale_status ?? null,
      developer: row?.product_develper_name ?? null,
      stockUser: row?.stock_user_name ?? null,
      price: asNumberOrNull(row?.price),
      pureWeight: asNumberOrNull(row?.pure_weight),
      totalCount,
      rawJson: null,
    };
  });
}

const args = [
  { name: 'skus', type: 'string', default: '', help: '多个 SKU，用逗号/空格/换行/分号/竖线分隔' },
  { name: 'productTypeCate', type: 'string', default: '', help: '产品类型：1/4/5/6，也可传中文' },
  { name: 'catalogId', type: 'string', default: '', help: '产品目录 ID；多个用逗号/空格分隔，单个父类目自动展开' },
  { name: 'pageSize', type: 'int', default: 20, help: '每个 SKU 返回数量，1-100' },
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
];

async function main(argsValue) {
  const skus = parseSkus(argsValue.skus);
  if (skus.length === 0) throw new EmptyResultError('new-erp game-product-batch', 'No SKU input');
  const productTypeCate = productTypeCateValue(argsValue.productTypeCate);
  const catalogId = expandCatalogIds(argsValue.catalogId);
  const pageSize = positiveInteger(argsValue.pageSize, 20, 'pageSize', 100);
  const token = await resolveToken(argsValue);

  const outputRows = [];
  for (const querySku of skus) {
    const rows = await queryOneSku({ token, querySku, pageSize, productTypeCate, catalogId });
    outputRows.push(...rows);
  }
  if (outputRows.length === 0) throw new EmptyResultError('new-erp game-product-batch', 'No products found');
  return outputRows;
}

if (require.main === module) {
  runCli({
    name: 'game-product-batch',
    description: '批量查询 new-erp 产品 SKU。',
    args,
    func: main,
  });
}
