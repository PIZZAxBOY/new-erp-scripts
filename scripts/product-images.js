const {
  ArgumentError, CommandExecutionError, EmptyResultError, getBaseUrl,
  requestJson, resolveImageUrl, resolveToken,
} = require('./shared.js');
const { authArgs, queryData } = require('./query.js');

const SEARCH_ROUTE = '/products/game-product-list/get-search-sku';
const IMAGE_ROUTE = '/products/game-product-list/image-list';
const groups = [
  { dealType: '1', windowImageType: '1', label: 'AMZ橱窗图' },
  { dealType: '1', windowImageType: '2', label: 'AMZ小图' },
  { dealType: '1', windowImageType: '3', label: '国内销售橱窗图' },
  { dealType: '2', windowImageType: null, label: '包装图' },
  { dealType: '3', windowImageType: null, label: '宣传图' },
  { dealType: '4', windowImageType: null, label: '样品图' },
];

const args = [
  { name: 'sku', type: 'string', help: '必填，单个精确 ERP SKU；查询图片管理页全部六组图片及包装版本' },
  { name: 'raw', type: 'bool', default: false, help: '附带每组图集的原始 JSON' },
  ...authArgs,
];

function imageUrl(value, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const url = typeof value === 'string' && value.trim() ? resolveImageUrl(value) : null;
  if (!url) throw new CommandExecutionError('ERP image-list returned an invalid image URL; cannot return a complete gallery');
  return url;
}

function imageGroup(data, group, source, raw) {
  const list = data.image_list;
  if (!list || typeof list !== 'object' || Array.isArray(list)) {
    throw new CommandExecutionError('ERP image-list returned invalid image_list');
  }
  const mainImageUrl = imageUrl(list.img_main, true);
  const salesMainImageUrl = imageUrl(list.sale_main, true);
  const images = [];
  const add = (paths, stockVersion = null) => {
    if (!Array.isArray(paths)) throw new CommandExecutionError('ERP image-list returned invalid image array');
    for (const originalUrl of paths) {
      const url = imageUrl(originalUrl);
      images.push({ url, originalUrl, stockVersion,
        isMain: url === mainImageUrl, isSalesMain: url === salesMainImageUrl });
    }
  };
  if (group.dealType === '2') {
    const versions = list.stock_version_all;
    if (!versions || typeof versions !== 'object') {
      throw new CommandExecutionError('ERP image-list returned invalid stock_version_all');
    }
    for (const [version, paths] of Object.entries(versions)) add(paths, version);
  } else add(list.all);
  return { ...group, mainImageUrl, salesMainImageUrl, images, imageCount: images.length,
    source, rawJson: raw ? JSON.stringify(data) : null };
}

async function main(options = {}) {
  if (typeof options.sku !== 'string' || !options.sku.trim()) {
    throw new ArgumentError('sku must be a non-empty ERP SKU');
  }
  if (options.raw !== undefined && typeof options.raw !== 'boolean') {
    throw new ArgumentError('raw must be true or false');
  }
  const sku = options.sku.trim();
  const token = await resolveToken(options);
  const search = new URL(`${getBaseUrl()}/index.php`);
  search.searchParams.set('r', SEARCH_ROUTE);
  search.searchParams.set('sku', sku);
  const { data: matches } = await requestJson(search.href, { headers: { token }, label: SEARCH_ROUTE });
  if (!Array.isArray(matches) || matches.some((row) => !row || typeof row.sku !== 'string' || !row.sku.trim())) {
    throw new CommandExecutionError('ERP get-search-sku returned invalid SKU records');
  }
  if (!matches.some((row) => row.sku === sku)) {
    throw new EmptyResultError('new-erp product-images', 'No exact ERP SKU found');
  }
  const result = [];
  for (const group of groups) {
    const query = { sku, deal_type: group.dealType };
    if (group.windowImageType) query.window_img_type = group.windowImageType;
    const { data, source } = await queryData(IMAGE_ROUTE, query, { token });
    result.push(imageGroup(data, group, source, options.raw));
  }
  const urls = [...new Set(result.flatMap((group) => group.images.map((image) => image.url)))];
  return { sku, groups: result, imageCount: result.reduce((sum, group) => sum + group.imageCount, 0),
    uniqueImageCount: urls.length, urls, complete: true };
}

module.exports = { main, args };
