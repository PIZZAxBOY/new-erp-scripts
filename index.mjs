import packingBatchListModule from './scripts/packing-batch-list.js';
import packingBatchDetailModule from './scripts/packing-batch-detail.js';
import outerPackageListModule from './scripts/outer-package-list.js';
import inventoryListModule from './scripts/inventory-list.js';
import logisticsChannelListModule from './scripts/logistics-channel-list.js';
import productDeclarationListModule from './scripts/product-declaration-list.js';
import erpOptionsModule from './scripts/erp-options.js';
import catalogListModule from './scripts/catalog-list.js';
import categorySummaryModule from './scripts/category-summary.js';
import gameProductBatchModule from './scripts/game-product-batch.js';
import gameProductListModule from './scripts/game-product-list.js';
import productDetailModule from './scripts/product-detail.js';
import salesVolumeRankingModule from './scripts/sales-volume-ranking.js';
import salesVolumeExportModule from './scripts/sales-volume-export.js';
import supplyEvidenceModule from './scripts/supply-evidence.js';
import stockingAssemblyInboundModule from './scripts/stocking-assembly-inbound.js';
import erpClient from './scripts/shared.js';
import packingOrderListModule from './scripts/packing-order-list.js';
import packingDetailExportModule from './scripts/packing-detail-export.js';
import packingDetailModule from './scripts/packing-detail.js';
import planDeliveryOrderListModule from './scripts/plan-delivery-order-list.js';

export const catalogList = catalogListModule.main;
export const categorySummary = categorySummaryModule.main;
export const gameProductBatch = gameProductBatchModule.main;
export const gameProductList = gameProductListModule.main;
export const productDetail = productDetailModule.main;
export const salesVolumeRanking = salesVolumeRankingModule.main;
export const salesVolumeExport = salesVolumeExportModule.main;
export const supplyEvidence = supplyEvidenceModule.main;
export const stockingAssemblyInbound = stockingAssemblyInboundModule.main;
export { erpClient };
export const packingOrderList = packingOrderListModule.main;
export const packingOrderPages = packingOrderListModule.pages;
export const packingDetail = packingDetailModule.main;
export const planDeliveryOrderList = planDeliveryOrderListModule.main;
export const exportPackingDetails = packingDetailExportModule.main;

export async function exportGameProducts({ token, fields = ['sku', 'name_cn', 'price'], disused = false } = {}) {
  const route = disused ? '/products/game-product-list/disuse-product-export' : '/products/game-product-list/product-export';
  const auth = await erpClient.resolveToken({ token });
  const url = (route, params = {}) => {
    const result = new URL(`${erpClient.getBaseUrl()}/index.php`);
    result.searchParams.set('r', route);
    for (const [key, value] of Object.entries(params)) result.searchParams.set(key, String(value));
    return result.href;
  };
  const tasks = async (timeoutMs = 120_000) => {
    const { data } = await erpClient.requestJson(url('/settings/download-center/index',
      { page: 1, pageSize: 100 }), { headers: { token: auth }, label: 'ERP 下载中心', timeoutMs });
    if (!Array.isArray(data?.list)) throw new Error('ERP 下载中心未返回任务列表');
    return data.list;
  };
  const existing = new Set((await tasks()).map(row => String(row.id)));
  const body = new FormData();
  body.set('request_data[data_range_type]', '1');
  body.set('request_data[inventory_display_mode]', '1');
  body.set('request_data[export_data_type]', '1');
  for (const [index, field] of fields.entries()) {
    body.set(`request_data[export_filed][basic][${index}]`, field);
  }
  await erpClient.requestJson(url(route), {
    method: 'POST', headers: { token: auth }, body, label: 'ERP 商品导出',
  });
  const deadline = Date.now() + 20 * 60_000;
  let task;
  let taskId;
  while (Date.now() < deadline) {
    const rows = await tasks(Math.max(1, Math.min(120_000, deadline - Date.now())));
    if (taskId) {
      task = rows.find(row => String(row.id) === taskId);
      if (!task) throw new Error('ERP 商品导出任务已从下载中心消失');
    } else {
      const matches = rows.filter(row => {
        if (!row.id || existing.has(String(row.id))) return false;
        try {
          return row.route_url === route.slice(1)
            && JSON.stringify(JSON.parse(row.field_selects || '{}').basic) === JSON.stringify(fields);
        } catch { return false; }
      });
      if (matches.length > 1) throw new Error('ERP 商品导出存在多个匹配的新任务 (multiple matching new tasks)');
      task = matches[0];
      if (task) taskId = String(task.id);
    }
    if (Date.now() >= deadline) throw new Error('ERP 商品导出等待超时');
    if (String(task?.status) === '3') break;
    if (String(task?.status) === '4') throw new Error(`ERP 商品导出失败：${erpClient.redactSensitiveText(task.error_reason || task.id, [auth])}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(3000, Math.max(0, deadline - Date.now()))));
  }
  if (String(task?.status) !== '3') throw new Error('ERP 商品导出等待超时');
  const response = await fetch(url('/settings/download-center/download-file', { id: task.id }), {
    headers: { token: auth }, redirect: 'error', signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !/attachment/i.test(response.headers.get('content-disposition') || '')) {
    throw new Error(`ERP 商品导出下载失败：HTTP ${response.status}`);
  }
  const file = Buffer.from(await response.arrayBuffer());
  if (file.subarray(0, 2).toString() !== 'PK') throw new Error('ERP 商品导出不是 XLSX 文件');
  return { taskId: String(task.id), file };
}

export async function exportOuterPackages({ token, flowStatus } = {}) {
  if (!['1', '2', '3', '4', '5'].includes(String(flowStatus))) {
    throw new Error('flowStatus must be 1–5');
  }
  const auth = await erpClient.resolveToken({ token });
  const url = (route, params = {}) => {
    const result = new URL(`${erpClient.getBaseUrl()}/index.php`);
    result.searchParams.set('r', route);
    for (const [key, value] of Object.entries(params)) result.searchParams.set(key, String(value));
    return result.href;
  };
  const tasks = async (timeoutMs = 120_000) => {
    const { data } = await erpClient.requestJson(url('/settings/download-center/index',
      { page: 1, pageSize: 100 }), { headers: { token: auth }, label: 'ERP 下载中心', timeoutMs });
    if (!Array.isArray(data?.list)) throw new Error('ERP 下载中心未返回任务列表');
    return data.list;
  };
  const existing = new Set((await tasks()).map(row => String(row.id)));
  await erpClient.requestJson(url('/products/outer-package-product/export', { flow_status: flowStatus }), {
    headers: { token: auth }, label: 'ERP 外包装导出',
  });
  const deadline = Date.now() + 20 * 60_000;
  let task;
  let taskId;
  while (Date.now() < deadline) {
    const rows = await tasks(Math.max(1, Math.min(120_000, deadline - Date.now())));
    if (taskId) {
      task = rows.find(row => String(row.id) === taskId);
      if (!task) throw new Error('ERP 外包装导出任务已从下载中心消失');
    } else {
      const matches = rows.filter(row => {
        if (!row.id || existing.has(String(row.id))) return false;
        try {
          return row.route_url === 'products/outer-package-product/export'
            && String(JSON.parse(row.add_condition || '{}').flow_status) === String(flowStatus);
        } catch { return false; }
      });
      if (matches.length > 1) throw new Error('ERP 外包装导出存在多个匹配的新任务 (multiple matching new tasks)');
      task = matches[0];
      if (task) taskId = String(task.id);
    }
    if (Date.now() >= deadline) throw new Error('ERP 外包装导出等待超时');
    if (String(task?.status) === '3') break;
    if (String(task?.status) === '4') throw new Error(`ERP 外包装导出失败：${erpClient.redactSensitiveText(task.error_reason || task.id, [auth])}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(3000, Math.max(0, deadline - Date.now()))));
  }
  if (String(task?.status) !== '3') throw new Error('ERP 外包装导出等待超时');
  const response = await fetch(url('/settings/download-center/download-file', { id: task.id }), {
    headers: { token: auth }, redirect: 'error', signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !/attachment/i.test(response.headers.get('content-disposition') || '')) {
    throw new Error(`ERP 外包装导出下载失败：HTTP ${response.status}`);
  }
  const file = Buffer.from(await response.arrayBuffer());
  if (file.subarray(0, 2).toString() !== 'PK') throw new Error('ERP 外包装导出不是 XLSX 文件');
  return { taskId: String(task.id), file };
}

export const packingBatchList = packingBatchListModule.main;
export const packingBatchDetail = packingBatchDetailModule.main;
export const outerPackageList = outerPackageListModule.main;
export const inventoryList = inventoryListModule.main;
export const logisticsChannelList = logisticsChannelListModule.main;
export const productDeclarationList = productDeclarationListModule.main;
export const erpOptions = erpOptionsModule.main;
