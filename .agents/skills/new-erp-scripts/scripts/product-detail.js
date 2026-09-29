#!/usr/bin/env node
const {
  EmptyResultError,
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

async function resolveToken(args) {
  const existingToken = getTokenFromArgs(args);
  if (existingToken) return existingToken;
  const session = await loginToken(args);
  return session.token;
}

function pickFirstSkuVersion(versions) {
  return Array.isArray(versions) && versions.length > 0 ? versions[0] : {};
}

function detailRow(data, includeRaw) {
  const basic = data?.product_basic_info || {};
  const purchase = data?.purchase_info || {};
  const attribute = data?.product_attribute_info || {};
  const skuVersions = Array.isArray(data?.product_sku_version_list) ? data.product_sku_version_list : [];
  const firstVersion = pickFirstSkuVersion(skuVersions);

  return {
    id: basic.id ?? null,
    sku: basic.sku ?? purchase.sku ?? null,
    nameCn: basic.name_cn ?? null,
    nameEn: basic.name_en ?? null,
    productTypeCate: basic.product_type_cate ?? null,
    productType: basic.product_type ?? null,
    saleStatus: basic.sale_status ?? null,
    statusText: basic.status_text ?? null,
    purchaseStatus: basic.purchase_status ?? null,
    purchaseStatusCanModify: basic.purchase_status_can_modify ?? null,
    is3rdSku: basic.is_3rd_sku ?? purchase.is_3rd_sku ?? null,
    is3rdSkuText: purchase.is_3rd_sku_text ?? null,
    price: asNumberOrNull(basic.price),
    salePrice: asNumberOrNull(basic.sale_price),
    moqPrice: asNumberOrNull(basic.moq_price),
    pureWeight: asNumberOrNull(basic.pure_weight),
    totalWeight: asNumberOrNull(basic.total_weight),
    hwcWeight: asNumberOrNull(basic.hwc_weight),
    purchaser: purchase.purchaser_name ?? null,
    developer: basic.developer_name ?? null,
    stockUser: basic.stock_user_name ?? null,
    tester: basic.tester_name ?? null,
    categoryName: basic.category_name ?? null,
    shippingAttribute: basic.shipping_attribute_text ?? basic.shipping_attribute ?? null,
    imageUrl: basic.image_url ?? null,
    buyUrl: basic.buy_url ?? null,
    stockCode: basic.stock_code ?? null,
    shelfCode: basic.shelf_code ?? null,
    createdAt: basic.created_at ?? null,
    updatedDate: basic.updated_date ?? null,
    attributeId: attribute.id ?? null,
    skuVersionCount: skuVersions.length,
    firstBomNumber: firstVersion.bom_number_text ?? firstVersion.bom_number ?? null,
    firstBomStatus: firstVersion.bom_status_text ?? firstVersion.bom_status ?? null,
    firstVersionPrice: asNumberOrNull(firstVersion.price),
    rawJson: includeRaw ? JSON.stringify(data) : null,
  };
}

const args = [
  { name: 'id', type: 'int', default: 140496, help: '产品基础 ID' },
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
  { name: 'raw', type: 'bool', default: false, help: '附带完整详情原始 JSON' },
];

async function main(argsValue) {
  const id = positiveInteger(argsValue.id, 140496, 'id');
  const token = await resolveToken(argsValue);

  const url = new URL(`${getBaseUrl()}/index.php`);
  url.searchParams.set('r', '/products/product-basic/detail');
  url.searchParams.set('id', String(id));

  const json = await requestJson(url.href, {
    label: 'new-erp product-detail',
    headers: { token },
  });

  const data = json?.data;
  if (!data || Array.isArray(data) || !data.product_basic_info) {
    throw new EmptyResultError('new-erp product-detail', `No product detail found for id=${id}`);
  }

  return [detailRow(data, Boolean(argsValue.raw))];
}

module.exports = { main };

if (require.main === module) {
  runCli({
    name: 'product-detail',
    description: '按产品 ID 查询 new-erp 产品详情。',
    args,
    func: main,
  });
}
