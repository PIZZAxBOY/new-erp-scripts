# JavaScript API 与数据口径

安装与配置见 [README](../README.md#javascript-api)。函数接收与 CLI 同名的选项对象，返回结果或抛出错误；配置从调用时的当前工作目录或环境变量读取。

## 基础查询与客户端

基础查询导出 `catalogList`、`categorySummary`、`gameProductList`、`gameProductBatch`、`productDetail`、`salesVolumeRanking`、`salesVolumeExport`、`supplyEvidence` 和 `stockingAssemblyInbound`。

底层 ERP API 客户端通过 `erpClient` 导出，包含 `loginToken`、`getBaseUrl` 和 `requestJson`，供需要分页采集自定义 ERP 接口的项目复用。
`exportGameProducts({ token, fields })` 使用 ERP 商品导出任务，等待下载中心完成并返回 `{ taskId, file }`；`file` 是 XLSX Buffer，字段默认是 SKU、品名、单价。导出文件不含商品 ID。

`exportOuterPackages({ token, flowStatus })` 使用 ERP 外包装导出任务；`flowStatus` 为 1–5，返回 `{ taskId, file }`，其中 `file` 是 XLSX Buffer。

`exportGameProducts({ disused: true })` 使用游戏类淘汰产品原生导出接口 `/products/game-product-list/disuse-product-export`；返回下载中心任务 ID 和 XLSX，默认字段为 SKU、品名、单价。

## 销量与单据

`salesVolumeRanking` 默认返回一个分页；`fetchAll: true` 获取完整范围并重新排序。指定 `sku` 时抓取全部匹配页，再按 SKU 精确过滤；`aggregateBy: 'sku-platform'` 按平台拆分。`categorySummary` 统计完整范围内的记录行数，不是销售数量。日期未带时间时，开始使用 `00:00:00`，结束使用 `23:59:59`；父级分类 ID 使用实时分类树展开。

`supplyEvidence({ source })` 支持 `plan`、`move`、`inventory`、`assembly`、`cargo`。单据查询默认只取一页；完整核对请传 `fetchAll: true`。`plan` 和 `move` 的数量来自单据明细，不使用列表行的 `num`；搬运计划不代表调库完成。`salesVolumeExport` 通过下载中心异步导出，保留 ERP 的 GBK CSV。

`stockingAssemblyInbound` 按精确 SKU 和入库时间汇总备货拼装实际入库流水，用拼装单号核对生产任务。它只统计备货拼装，不包含采购进货或调库。

销量导出只复用查询条件完全匹配且没有额外非空筛选的任务。商品、外包装和装箱导出拒绝多个匹配的新任务，并在识别任务后固定任务ID，避免后续轮询切换到其他任务。

## 装箱历史与批量导出

`packingOrderList(options)` 支持两种范围：完整的 `project + warehouses + startDate + endDate`（扫描出库时间），或单独的精确总单号 `packingNo`。两种范围可叠加，`stockFrom` 只用于收窄，不能单独查询。传入任何历史范围字段时四项都必须完整；显式传入空的 `packingNo` 或 `stockFrom` 会报错，不忽略条件。`warehouses` 是完整目的仓名称数组或逗号分隔字符串，必须非空、不重复且无空白，允许指定非 FBA 仓。目的仓完整枚举由 `erpOptions({ source: 'packing' })` 的 `data.site_type_list` 提供，项目枚举为 `data.auction_site_list`。

列表保留 `{ ...ERP数据, list, totalCount, query }`，补充 `page/pageSize/fetchedCount/complete/source`。默认单页20条，上限100；可用 `fetchAll: true` 从第1页收集所有行，或用异步生成器 `packingOrderPages(options)` 逐页消费。后者同样从第1页开始，省略 `fetchAll`，每次返回 `{ ...ERP数据, list: 当前页, totalCount, query, page, pageSize, fetchedCount: 累计行数, complete: 是否末页, source }`。空结果也返回一页。每页严格检查数量、总数稳定及重复箱号（无箱号时用ID），核对指定的总单号、发货仓和目的仓；错误直接抛出。

两个全量入口都有 `maxPages` 保护（默认100，最多1000），第一请求发现超限即报错。逐页读取没有预取，消费方处理完当前页才发下一请求，提前结束迭代不再请求；内存保留当前页和本次查询的去重键，不保留全部箱记录。去重键随已读行数增长，受页数上限约束。大范围回放应按项目和月份拆分，显式用 `pageSize: 100`；单页 `page` 查询可用于调用方自己的检查点。`fetchAll` 会保留全部行，不适合大批历史回放。

`exportPackingDetails({ project, warehouses, startDate, endDate, packingNo?, stockFrom?, status?, token?, output?, onProgress?, pollMs?, timeoutMs?, taskId? })` 优先使用 `/warehouse/packing-order/down-packing-detail` 原生批量导出。完整历史四项仍必填，`packingNo`、`stockFrom` 只能额外收窄；总单号映射为 `number_field=packing_num`、`number_value`。验证中仅传总单号和发货仓时 ERP 返回 `code=0, msg=请选择项目`，因此未开放仅总单号导出。

默认返回 `{ taskId, file, boxes, query }`，`file` 为 XLSX Buffer，可直接交给解析器，不必落盘；`boxes` 为本次列表箱数。无数据时 `taskId=""`、`file=null`、`boxes=0`，不创建任务。传 `output` 时以不覆盖模式保存文件，返回 `{ taskId, output, bytes, boxes, query }`；空结果不创建空文件。轮询默认 `pollMs: 3000`、`timeoutMs: 1200000`（等待任务的时限，不含前置查询和文件下载）；兼容 `pollMs: 2000, timeoutMs: 600000`。两项必须为正整数。

默认只匹配本次新任务，不复用旧快照。识别任务后，`onProgress` 先收到 `{ stage: 'waiting', boxes, taskId }`，可立即保存ID；下载前收到同形的 `stage: 'download'`。只有显式 `taskId` 才恢复轮询和下载，不创建新任务；恢复同样要求完整查询，逐次核对任务路由和全部筛选条件，拒绝额外非空条件、失败、消失或不匹配的任务。必要时串行查找下载中心后续页，最多1000页，每页100条，并受等待时限限制。显式恢复的是原任务快照，`boxes` 是恢复时的列表计数，调用方仍需核对文件内容；它不证明快照仍与当前业务一致。

已出库箱优先从批量文件读取 SKU、数量和销售包装；仅为未出库箱或导出缺失的必要字段补读 `packingDetail`。需复核采集期间的SKU、包装变化时，可做两次新导出比较完整清单，调用时都不传 `taskId`。批量主数据已有 `exportGameProducts({ token, fields, disused? })`、`exportOuterPackages({ token, flowStatus })`，都返回 XLSX Buffer；前者保留 ERP 指定导出字段，不能替代包含全部版本的 `productDetail`，后者可按包装类型建立本地快照。

```js
import { packingOrderPages, exportPackingDetails } from 'new-erp-scripts';

const selection = {
  project: 'DEMO-PROJECT', warehouses: ['DEMO-DEST'],
  startDate: '2026-07-01', endDate: '2026-09-30',
};
for await (const page of packingOrderPages({ ...selection, pageSize: 100 })) {
  await consumePage(page); // 写入调用方的检查点或逐页处理
}
const detail = await exportPackingDetails({ ...selection, packingNo: 'YOUR-ORDER', stockFrom: 'DEMO-FROM',
  pollMs: 2000, timeoutMs: 600000,
  onProgress: async ({ taskId }) => { await saveTaskId(taskId); },
});
// 用保存的ID恢复：exportPackingDetails({ ...selection, packingNo: 'YOUR-ORDER', stockFrom: 'DEMO-FROM', taskId })
```

对应 CLI 为 `new-erp-packing-order-list`、`new-erp-packing-order-pages` 和 `new-erp-packing-detail-export`。逐页命令每页输出一行 JSON（NDJSON），遵守标准输出背压；导出命令须传 `--output ./packing.xlsx`，可用 `--taskId` 恢复。导出保持 ERP 原文，包含 SKU、数量、渠道、箱实重kg和尺寸cm，不直接返回四种运输占比或货代最终结算重量。

### 请求数验证

请求数自检：`node --test --test-name-pattern='pageSize 100' test/packing-history.test.js`。固定1000箱的本地数据，默认每页20条发50次请求，每页100条发10次，减少80%，所得记录计数和ID校验和一致。按120000箱计算分别为6000次和1200次（需按月拆分满足分页上限）；这是请求数推算，不是ERP实测速率。

## 配货、库存与包装

以下接口均支持 ES module 导入，同时提供同名连字符 CLI（如 `packingBatchList` 对应 `new-erp-packing-batch-list`）。只读取 ERP 数据，不创建或修改业务单据。

| API | 必填选项 | 返回内容 |
| --- | --- | --- |
| `packingBatchList` | `stockFrom` | 配货批次列表，默认 `status: '5'`（已配货待装箱）；`status: ''` 查询全部。可按 `batchNo`、`warehouse` 搜索，`packingNo` 精确收窄总单。 |
| `packingBatchDetail` | `stockFrom`、`batchNo` | 批次明细，保留原始 `provider` 分组、SKU、`num/can_num/now_num`、`version_number/bom_number`。这些数量和版本字段不自动互相替代。 |
| `packingDetail` | `packingNumNo`、`stockFrom`、`status`、`siteType` | `/warehouse/transfer-order-packing/packing-detail` 原箱明细，返回 `{ ...ERP数据, source }`。`status` 取列表原值，允许0；核对箱号、发货仓及返回的目的仓，保留 `packing_sku`、尺寸和重量原值，不补造销售包装或BOM。 |
| `planDeliveryOrderList` | `stockFrom`、`packingNo` | `/sales/plan-delivery-order/list` 历史配货明细，支持标准分页和 `fetchAll`；精确核对总单和发货仓，按ID检查重复，保留版本、跟单和已装数量。 |
| `outerPackageList` | `flowStatus` | 1=外包装SKU、2=方装头程、3=异装头程、4=无BZ版本SKU、5=无BZ版本头程；可按 `sku`、`project` 搜索，保留所有返回版本、箱规、单箱数量和实时枚举。 |
| `inventoryList` | `sku`、`stockCode` | 国内仓库存；默认 `groupBy: 'batch'` 保留库存批次/BOM；`groupBy: 'warehouse'` 按 SKU＋仓库汇总。精确核验返回的 SKU 和仓库。 |
| `logisticsChannelList` | 无 | 渠道ID、运输方式、材积除数、状态等原始配置；不额外推断运价或限重。 |
| `productDeclarationList` | 无 | 可按 `sku`、`country`（如 `US/IT`）搜索申报品名、材质、用途、HS编码、价格和币种。保留空白字段。 |
| `erpOptions` | `source` | `inventory`=库存枚举，`packing`=装箱状态/目的仓/渠道等，`batchWarehouses`=配货发货仓列表；返回 `{ data, source }`。 |

列表 API 返回 `{ list, totalCount, fetchedCount, complete, source, ...ERP元数据 }`，默认第1页20条。支持 `page`、`pageSize`（最多100）、`fetchAll` 和 `maxPages`（默认100，最多1000）。`fetchAll: true` 必须从第1页开始，校验每页数量及总数稳定；发生截断或总数变化时抛错。空结果返回空列表，不补造记录。`source` 包含路由、查询参数和采集时间，不包含认证信息；其他 ERP 元数据（如汇总值）保持首页原样，不作为包重新计算的全量汇总。

分页出现重复记录时抛错，不静默去重；库存和外包装按完整记录检测重复，保留同一商品的不同批次、BOM和包装版本。`supplyEvidence` 和实际入库查询也使用相同的分页数量校验，入库数量缺失或空白时抛错，不补零。

```js
import { packingBatchList, packingBatchDetail, outerPackageList, inventoryList } from 'new-erp-scripts';

const batches = await packingBatchList({ stockFrom: 'DEMO-FROM', fetchAll: true });
if (batches.list.length) {
  const detail = await packingBatchDetail({ stockFrom: 'DEMO-FROM', batchNo: batches.list[0].confirmed_no });
}
const packaging = await outerPackageList({ flowStatus: 2, sku: 'DEMO-SKU-003', fetchAll: true });
const inventory = await inventoryList({ sku: 'DEMO-SKU-003', stockCode: 'DEMO-STOCK', fetchAll: true });
```

`productDetail` 在原有返回字段之外，直接提供 `fatherId`、`packingId`、`packWeight`、`trueWeight`、`productAttributeInfo`、`skuVersions`（全部版本）和 `exportLogisticsDeclaration`，不再需要开启 `raw` 才能读取这些数据。旧的 `firstVersion*` 字段保留；不能据此替具体批次选择版本。

注意数据口径：

- 库存 `stock_count.num` 是即时库存，`yg_can_stock_count.num` 是预计可用库存。后者包含预计入库、预计出库和预留量，不代表已签收可装箱数量。库存批次 `advice_id` 与配货批次 `confirmed_no` 属于不同标识。
- 批次 `version_number`、BOM编号与商品 `pack_version` 的关联，以及父编号含义和国家适用规则，尚不能只凭字段名确定。
- 外包装记录会包含禁用BOM和多版本，SKU搜索可能匹配多个SKU；调用方需按精确SKU、BOM状态、包装版本和箱型核对，不自动取首条。
- 尺寸重量保留各来源原值。同一SKU在商品详情与外包装列表中的 `pure_weight` 可能使用不同单位，不能直接跨接口相加。箱内尺寸、空箱皮重、承重上限、混装规则及单位仍需业务核定。

## 验证范围

已验证配货批次、批次明细、外包装、库存、物流渠道和申报查询。真实 SKU、批次号、仓库名称及返回数量已省略；结果数量随业务变化，不能据此推断上游调拨已签收。搬运计划接口可能受账号权限限制，遇到403应报告权限缺口，不绕过权限。
