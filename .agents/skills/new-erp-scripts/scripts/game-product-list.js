const {
  ArgumentError,
  EmptyResultError,
  expandCatalogIds,
  getBaseUrl,
  getTokenFromArgs,
  loginToken,
  positiveInteger,
  requestJson,
  runCli,
} = require('./shared.js');

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

function productRow(row, meta, includeRaw) {
  const skuInfo = row?.sku_info || {};
  return {
    id: row?.id ?? null,
    sku: row?.sku ?? skuInfo?.sku ?? null,
    nameCn: row?.name_cn ?? null,
    productType: skuInfo?.product_type_text ?? null,
    skuType: skuInfo?.is_3rd_sku_name ?? null,
    packVersion: skuInfo?.pack_version ?? null,
    bomStatus: skuInfo?.bom_status ?? null,
    saleStatus: row?.sale_status_text ?? row?.sale_status ?? null,
    purchaser: row?.purchaser ?? null,
    developer: row?.product_develper_name ?? null,
    stockUser: row?.stock_user_name ?? null,
    price: asNumberOrNull(row?.price),
    pureWeight: asNumberOrNull(row?.pure_weight),
    saleIn7Days: asNumberOrNull(row?.sale_in_7_days),
    saleIn30Days: asNumberOrNull(row?.sale_in_30_days),
    totalCount: meta.totalCount,
    imageUrl: row?.image_url ?? null,
    rawJson: includeRaw ? JSON.stringify(row) : null,
  };
}

async function resolveToken(args) {
  const existingToken = getTokenFromArgs(args);
  if (existingToken) return existingToken;
  const session = await loginToken(args);
  return session.token;
}

const args = [
  { name: 'sku', type: 'string', default: '', help: 'SKU 关键字；可留空只按分类筛选' },
  { name: 'nameCn', type: 'string', default: '', help: '中文品名关键字；映射到接口参数 name_cn' },
  { name: 'productTypeCate', type: 'string', default: '', help: '产品类型：1/4/5/6，也可传中文' },
  { name: 'catalogId', type: 'string', default: '', help: '产品目录 ID；多个用逗号/空格分隔，单个父类目自动展开' },
  { name: 'page', type: 'int', default: 1, help: '页码' },
  { name: 'pageSize', type: 'int', default: 20, help: '每页数量，1-100' },
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
  { name: 'raw', type: 'bool', default: false, help: '附带每行原始 JSON' },
];

async function main(argsValue) {
  const sku = String(argsValue.sku ?? '').trim();
  const nameCn = String(argsValue.nameCn ?? '').trim();
  const productTypeCate = productTypeCateValue(argsValue.productTypeCate);
  const catalogId = expandCatalogIds(argsValue.catalogId);
  const page = positiveInteger(argsValue.page, 1, 'page');
  const pageSize = positiveInteger(argsValue.pageSize, 20, 'pageSize', 100);
  const token = await resolveToken(argsValue);

  const url = new URL(`${getBaseUrl()}/index.php`);
  url.searchParams.set('r', '/products/game-product-list/index');
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  if (sku) url.searchParams.set('sku', sku);
  if (nameCn) url.searchParams.set('name_cn', nameCn);
  if (productTypeCate) url.searchParams.set('product_type_cate', productTypeCate);
  if (catalogId) url.searchParams.set('catalog_id', catalogId);

  const json = await requestJson(url.href, {
    label: 'new-erp game-product-list',
    headers: { token },
  });

  const rows = Array.isArray(json?.data?.list) ? json.data.list : [];
  if (rows.length === 0) {
    throw new EmptyResultError(
      'new-erp game-product-list',
      `No products found for sku=${sku || '(empty)'}, nameCn=${nameCn || '(empty)'}, catalogId=${catalogId || '(empty)'}`,
    );
  }

  const meta = {
    page: Number(json?.data?.page ?? page),
    pageSize: Number(json?.data?.pageSize ?? pageSize),
    totalCount: Number(json?.data?.totalCount ?? rows.length),
  };
  return rows.map((row) => productRow(row, meta, Boolean(argsValue.raw)));
}

if (require.main === module) {
  runCli({
    name: 'game-product-list',
    description: '查询 new-erp 产品列表。',
    args,
    func: main,
  });
}
