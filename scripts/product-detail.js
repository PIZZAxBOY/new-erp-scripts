const {
  asNumberOrNull,
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  getBaseUrl,
  resolveImageUrl,
  resolveToken,
  positiveInteger,
  requestJson,
} = require('./shared.js');
const { productsForAsin } = require('./product-asin.js');

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
    imageUrl: resolveImageUrl(basic.full_image_url, basic.image_url),
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
    fatherId: basic.father_id ?? null,
    packingId: basic.packing_id ?? null,
    packWeight: asNumberOrNull(basic.pack_weight),
    trueWeight: asNumberOrNull(basic.true_weight),
    productAttributeInfo: attribute,
    skuVersions,
    exportLogisticsDeclaration: data?.export_logistics_declaration ?? null,
    rawJson: includeRaw ? JSON.stringify(data) : null,
  };
}

const args = [
  { name: 'id', type: 'int', help: '产品基础 ID；与 asin 二选一' },
  { name: 'asin', type: 'string', help: '按 ASIN 搜索 ERP Listing，再查询关联商品；与 id 二选一' },
  { name: 'maxPages', type: 'int', default: 100, help: 'ASIN 及 SKU 搜索各自的最多页数，1–1000' },
  { name: 'username', type: 'string', default: '', help: 'ERP 账号；也可用 NEW_ERP_USERNAME' },
  { name: 'password', type: 'string', default: '', help: 'ERP 密码；也可用 NEW_ERP_PASSWORD' },
  { name: 'token', type: 'string', default: '', help: '已有 token；传入后跳过登录' },
  { name: 'raw', type: 'bool', default: false, help: '附带完整详情原始 JSON' },
];

async function detailById(id, { token, raw }) {
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

  return detailRow(data, Boolean(raw));
}

async function main(options = {}) {
  const hasId = options.id !== undefined;
  const hasAsin = options.asin !== undefined;
  if (hasId === hasAsin) throw new ArgumentError('Provide exactly one of id or asin');
  const maxPages = positiveInteger(options.maxPages, 100, 'maxPages', 1000);
  let id;
  let asin;
  if (hasId) id = positiveInteger(options.id, undefined, 'id');
  else {
    asin = String(options.asin ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new ArgumentError('asin must be exactly 10 letters or digits');
  }
  const token = await resolveToken(options);
  if (hasId) return [await detailById(id, { token, raw: options.raw })];
  const products = await productsForAsin(asin, { token, maxPages });
  const rows = [];
  for (const product of products) {
    const row = await detailById(product.id, { token, raw: options.raw });
    if (String(row.id) !== String(product.id) || row.sku !== product.sku) {
      throw new CommandExecutionError('ERP product detail does not match the ASIN lookup product ID or SKU');
    }
    rows.push({ ...row, asin, asinListings: product.asinListings, asinSource: product.asinSource });
  }
  return rows;
}

module.exports = { main, args };
