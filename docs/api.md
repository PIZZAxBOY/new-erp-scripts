# JavaScript API

API 保持原有 ES module 导出，选项以对象传递；业务参数、返回值和 ERP 口径不因 MCP 启动方式变化。安装与客户端配置见 [README](../README.md)。

```js
import { gameProductList, productDetail, marketOrderList, erpClient } from 'new-erp-mcp';

const products = await gameProductList({ sku: 'DEMO-SKU-001' });
const detail = await productDetail({ asin: 'B012345678' });
const orders = await marketOrderList({ searchType: 3, searchValue: 'DEMO-ORDER-ID' });
```

## 配置与认证

ERP 地址优先从 `NEW_ERP_BASE_URL` 读取，也可在项目工作目录的 `config.json` 中提供 `baseUrl`。直接 API 消费者可使用显式 `token`、环境变量或配置中的 token；必要时 `erpClient.loginToken` 可通过 ERP 登录 API 获取 token。不要把密码或 token 写入源码、日志、对话或版本库。

MCP API 调用不使用以上共享认证回退，始终绑定本机 `auth.login` 保存的私有会话。`erpClient` 导出 `loginToken`、`getBaseUrl` 与 `requestJson`，供自定义消费者复用。

## 业务 API

| 导出 | 用途 |
| --- | --- |
| `marketOrderList` | 只读查询市场订单 |
| `catalogList` | 查询商品分类 |
| `categorySummary` | 汇总分类销量 |
| `gameProductBatch`、`gameProductList` | 商品批量查询与搜索 |
| `productDetail` | 按商品 ID 或 ASIN 查询详情 |
| `salesVolumeRanking`、`salesVolumeExport` | 销量排名与异步 CSV 导出 |
| `supplyEvidence`、`stockingAssemblyInbound` | 查询计划/库存/货物流转凭证和拼装实际入库 |
| `packingOrderList`、`packingOrderPages`、`packingDetail`、`exportPackingDetails` | 装箱列表、逐页遍历、单箱详情和 XLSX 导出 |
| `planDeliveryOrderList`、`packingBatchList`、`packingBatchDetail` | 配货及批次明细 |
| `outerPackageList`、`exportOuterPackages` | 外包装查询与 XLSX 导出 |
| `inventoryList`、`logisticsChannelList`、`productDeclarationList`、`erpOptions` | 库存、物流、申报与枚举 |
| `exportGameProducts` | 按选择字段导出商品 XLSX |

## 关键契约

`marketOrderList(options)` 调用只读 `GET /index.php?r=/marketing/market-order/index`，支持 `searchType` 1–6、`searchValue`、项目、状态和交易 ID。`searchType` 缺省为 3；状态可为 0、负数或空值。原始响应保存在 `rawJson`，完整分页需显式设置 `fetchAll`，并检查 `complete` 与 `totalCount`。路由和字段由 ERP 接口文档及前端请求映射交叉确认；不创建、更新或导出订单。

`productDetail` 的 `id` 与 `asin` 必须且只能提供一个。ASIN 使用 ERP 商品搜索和详情流程；响应需核对 ASIN 与 SKU，不能假设模糊结果精确匹配。图片字段保留 ERP 原始路径，不保证是完整图库，详见 [ASIN 接口契约](./erp-asin-contract.md)。

商品批量查询与销量排名校验分页元数据和预期行数；错误或短页不会被当成“未找到”或用于错误排名。部分 ERP 搜索本身模糊，`found` 只表示返回了结果，不表示精确 SKU 命中。分页数组要结合总数、筛选条件和完整性状态解释。

销量 CSV 导出每次调用都会提交新的 ERP 导出请求，只选择本次提交后的新任务，并校验目标路由、完整查询条件和日期范围；不会复用历史成功或失败任务。调用方应提供唯一输出路径，并通过任务结果处理异步完成。

`packingOrderPages(options)` 返回异步生成器；`fetchAll` 不适用于逐页 MCP 操作。`exportPackingDetails(options)` 返回任务结果及文件 buffer，可通过 `onProgress` 记录任务 ID 以便恢复。库存、计划、BOM、包装规格及重量单位保留 ERP 原始口径，不自动合并或猜测。API 的分页、校验和安全边界由函数参数元数据与实现定义，消费前先核对过滤条件和数据范围。

只读操作不会创建或修改业务单据。导出会在 ERP 下载中心创建任务并产生本地文件。请仅查询明确授权的数据，勿保存或分享未脱敏的原始业务响应。
