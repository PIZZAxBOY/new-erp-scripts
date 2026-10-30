# 命令与数据口径

示例中的 `DEMO-*` 和商品 ID 均为占位值，执行前替换为实际值。

## 命令选择

| 用户需求 | 命令 |
| --- | --- |
| 获取市场订单，按系统单号、红人编码、邮箱、跟踪号或 SKU 搜索 | `new-erp-market-order-list` |
| 查找商品分类或分类 ID | `new-erp-catalog-list` |
| 按 SKU、中文名称、类型或分类搜索商品 | `new-erp-game-product-list` |
| 一次查询多个 SKU | `new-erp-game-product-batch` |
| 按商品 ID 查看单个商品 | `new-erp-product-detail` |
| 按日期范围统计 SKU 销量排名，精确查 SKU 或按 SKU+平台拆分 | `new-erp-sales-volume-ranking` |
| 大范围异步导出 SKU、SKU+平台或平台销量 CSV | `new-erp-sales-volume-export` |
| 查询销售计划、搬运计划、成品出入库、组装计划或货物流转单据 | `new-erp-supply-evidence` |
| 按 SKU 和日期统计备货拼装的实际入库数量 | `new-erp-stocking-assembly-inbound` |
| 按精确总单号或完整历史范围查询装箱单列表 | `new-erp-packing-order-list` |
| 串行读取全部装箱分页，每页输出一行 JSON | `new-erp-packing-order-pages` |
| 按原箱号、发货仓、状态和目的仓读取单箱明细 | `new-erp-packing-detail` |
| 按总单号和发货仓查询历史配货明细 | `new-erp-plan-delivery-order-list` |
| 原生导出完整装箱明细（SKU、数量、渠道、箱重和尺寸） | `new-erp-packing-detail-export` |
| 查询实际配货批次，默认已配货待装箱 | `new-erp-packing-batch-list --stockFrom DEMO-FROM` |
| 读取批次SKU、数量和BOM/版本原字段 | `new-erp-packing-batch-detail --stockFrom DEMO-FROM --batchNo <批次号>` |
| 查询方装/异装多版本箱规和单箱容量 | `new-erp-outer-package-list --flowStatus 2 --sku <SKU>` |
| 按SKU、国内仓查询库存批次/BOM或仓库汇总 | `new-erp-inventory-list --sku <SKU> --stockCode DEMO-STOCK` |
| 查询头程渠道、运输方式和材积除数 | `new-erp-logistics-channel-list` |
| 查询SKU/国家申报主数据 | `new-erp-product-declaration-list --sku <SKU> --country US` |
| 读取实时库存/装箱枚举或配货仓列表 | `new-erp-options --source inventory` |
| 按 ERP 分类统计匹配的 SKU 销售记录数 | `new-erp-category-summary` |


## 市场订单

```sh
new-erp-market-order-list --searchValue DEMO-ORDER-ID
new-erp-market-order-list --searchType 6 --searchValue DEMO-SKU-001 --fetchAll
```

`searchType`：1跟踪号、2转单号、3系统单号（默认）、4红人编码、5邮箱、6 SKU；必须与非空 `searchValue` 配合。还可传 `project`、`status`、`transactionId`，未传状态时查询全部状态。系统单号对应 `id`，交易号对应 `transaction_id`，不要混用平台单号 `item_no`。搜索按 ERP 原生匹配规则，不在本地二次筛选。

只读市场订单列表，不创建、修改或导出订单。保留原始订单、SKU 明细、物流信息和响应枚举（如 `order_status_map`），金额、数量及空值不自动转换。分页规则与其他列表一致，按订单 ID 检查重复。无筛选默认只查第一页，不代表全量；买家信息和搜索条件可能含个人信息，对外分享前脱敏。

## 查询示例与统计口径

```bash
new-erp-catalog-list --keyword 游戏内配
new-erp-game-product-list --sku DEMO-SKU-001
new-erp-game-product-batch --skus 'SKU-A,SKU-B'
new-erp-product-detail --id 12345
new-erp-sales-volume-ranking --startDate 2026-01-01 --endDate 2026-01-31
new-erp-sales-volume-ranking --startDate 2026-01-01 --endDate 2026-01-31 --sku DEMO-SKU-002 --aggregateBy sku-platform
new-erp-sales-volume-export --startDate 2026-01-01 --endDate 2026-01-31 --aggregateBy platform --output ./platform-2026-01.csv
new-erp-supply-evidence --source plan --sku DEMO-SKU-002 --startDate 2026-01-01 --endDate 2026-03-31 --fetchAll
new-erp-supply-evidence --source move --sku DEMO-SKU-002 --startDate 2026-01-01 --endDate 2026-03-31 --fetchAll
new-erp-supply-evidence --source inventory --sku DEMO-SKU-002 --startDate 2026-01-01 --endDate 2026-03-31 --fetchAll
new-erp-supply-evidence --source assembly --sku DEMO-SKU-002 --fetchAll
new-erp-supply-evidence --source cargo --sku DEMO-SKU-002 --fetchAll
new-erp-stocking-assembly-inbound --sku DEMO-SKU-002 --startDate 2026-08-30 --endDate 2026-09-28
new-erp-packing-order-list --project DEMO-PROJECT --warehouses 'DEMO-DEST' --startDate 2026-07-01 --endDate 2026-09-30
new-erp-packing-order-list --packingNo YOUR-ORDER --stockFrom DEMO-FROM --fetchAll --pageSize 100
new-erp-packing-order-pages --project DEMO-PROJECT --warehouses 'DEMO-DEST' --startDate 2026-07-01 --endDate 2026-09-30 --pageSize 100
new-erp-plan-delivery-order-list --stockFrom DEMO-FROM --packingNo YOUR-ORDER --fetchAll
new-erp-packing-detail-export --project DEMO-PROJECT --warehouses 'DEMO-DEST' --startDate 2026-07-01 --endDate 2026-09-30 --output ./packing.xlsx
new-erp-category-summary --startDate 2026-01-01 --endDate 2026-01-31
```

单个父级分类 ID 会使用 ERP 实时分类树自动展开。只填写日期时，开始时间使用 `00:00:00`，结束时间使用 `23:59:59`。`sales-volume-ranking` 默认返回 ERP 排序后的一个分页。需要完整结果并重新排序时，使用 `--fetchAll true`。`category-summary` 始终获取整个匹配范围，统计的是记录行数，不是销售数量。

销量接口的 `sku` 是前缀查询；排行脚本传 `--sku` 时会自动抓取全部匹配页，再按 SKU 精确过滤。`--aggregateBy sku-platform` 可查看平台拆分；平台整体汇总请用异步导出，CSV 保持 ERP 的 GBK 编码。导出脚本会复用下载中心的同条件任务，不覆盖已有文件。

销量导出不会复用含额外非空筛选的任务。分页截断、重复记录和多个匹配的新导出任务均会报错，不将异常数据当成完整结果；库存和外包装保留同一商品的不同批次/BOM/版本。认证请求与文件下载拒绝重定向，JSON请求含正文读取默认最多120秒，导出轮询请求受20分钟剩余等待时间约束。

`supply-evidence` 的 `plan` 和 `move` 会用列表中的 `id` 和 `confirmed_no` 读取单据明细，只返回明细 SKU 精确匹配的计划数量 `plannedNum`；列表行的 `num` 不是整单数量。`inventory` 返回成品出入库记录，`assembly` 和 `cargo` 返回备货候选记录。后两者的 ERP 日期筛选不可靠，因此脚本不提供日期参数。默认只抓一页；需要完整结果时传 `--fetchAll`。库存实时字段、搬运计划及调库申请/过渡仓记录不能视为历史库存或目的仓签收。

`stocking-assembly-inbound` 将成品入库流水按拼装单号与类型为“备货拼装”的生产任务关联，仅汇总所选时间内实际入库的精确 SKU 数量；采购进货和调库另属其他流程。

## 装箱历史与导出

`packing-order-list` 和 `packing-order-pages` 支持精确总单号 `--packingNo` 单独查询，或完整历史范围 `--project + --warehouses + --startDate + --endDate`；两种范围可叠加。只要传入任一历史范围字段，四项就必须齐全。`--stockFrom` 只能收窄查询，不能单独使用；显式传入空的总单号或发货仓会报错。

历史范围的目的仓必须使用完整名称，不重复、不含空白，以逗号分隔；允许明确指定非FBA仓。用 `new-erp-options --source packing` 获取 `data.site_type_list` 目的仓枚举和 `data.auction_site_list` 项目枚举。日期按扫描出库时间（`time_type=out_time`），默认状态不限。

`packing-order-list` 默认单页，加 `--fetchAll` 才收集全量箱记录，列表本身不提供完整 SKU 明细。大范围历史优先按项目、月份拆分，使用 `packing-order-pages --pageSize 100` 逐页处理；该命令始终从第1页读取，不传 `--fetchAll`，每页的 `fetchedCount` 是累计箱数，`complete` 表示是否末页。它串行请求、没有预取，内存保留当前页和本次已读记录的去重键；提前停止消费不再发起后续请求。两个全量入口均受 `maxPages` 限制，第一请求发现所需页数超限即报错。

已出库箱优先使用 `packing-detail-export` 原生 XLSX 批量读取 SKU、数量和销售包装；仅为未出库箱或批量导出缺少的必要字段补读 `packing-detail`。单箱查询必须传列表原值 `--packingNumNo`、`--stockFrom`、`--status`（允许0）和 `--siteType`，不要猜测状态或目的仓。`plan-delivery-order-list` 按总单号和发货仓读取历史配货，保留版本、跟单及已装数量字段，不用它替代原箱明细。

`packing-detail-export` 仍要求完整历史四项；`--packingNo` 和 `--stockFrom` 只能额外收窄，不能只凭总单号导出。CLI 必须传 `--output`，不覆盖已有文件；新导出无数据时不生成任务或空文件。保持箱实重kg、尺寸cm及SKU行原文；同箱多行箱重重复，后续按箱去重统计时必须先核验一致性。运输比例及估算计费重由调用项目计算，不能把导出箱实重当成货代最终计费重。

默认仅匹配本次新建的导出任务。显式传 `--taskId` 才恢复原任务，不再创建新任务；恢复必须同时提供原完整查询，逐次核对任务路由和全部筛选条件。`--pollMs` 默认3000、`--timeoutMs` 默认1200000，均为正整数；超时只约束任务等待阶段，不含前置查询和文件下载。恢复得到的是旧任务快照，返回的 `boxes` 是恢复时列表计数，仍需核对文件内容。

代码集成可用 `packingOrderPages(options)` 异步生成器和 `exportPackingDetails(options)`。导出 API 不传 `output` 时返回 XLSX Buffer（空结果为 `file: null`）；用 `onProgress` 保存 `waiting` 阶段的 `taskId`，便于失败后显式恢复，下载前还会收到 `download` 阶段。需核对采集期间的SKU或包装变化时，做两次新导出并比较完整清单，两次均不传 `taskId`。


## 装箱数据口径

- `product-detail` 直接返回全部 `skuVersions`、`productAttributeInfo`、`fatherId/packingId` 和 `exportLogisticsDeclaration`，无需 `--raw`。旧首版本字段仅为兼容，不能据此确定批次版本。
- `packing-batch-detail` 保留 `provider` 分组以及 `num/can_num/now_num`、`version_number/bom_number`，不把这些数量或版本字段互换。配货批次不是历史装箱单，也不等于已完成调拨签收证明。
- `inventory-list` 默认 `groupBy=batch`，按库存批次/BOM返回；`groupBy=warehouse` 汇总到SKU＋仓库。`stock_count.num` 为即时库存，`yg_can_stock_count.num` 包含预计入库等预测量，不能作为已签收可装箱库存；不要重复累加两种分组。
- 外包装 `flowStatus` 为1外包装SKU、2方装头程、3异装头程、4无BZ版本SKU、5无BZ版本头程。保留全部返回版本与BOM状态，调用方按精确SKU、包装版本、有效BOM和箱型匹配；不能自动取第一条。
- 不同来源尺寸/重量单位可能不同，保留原值。同一SKU详情与外包装的 `pure_weight` 可能使用不同单位，未核定前不跨接口直接累加或自行统一单位。不要把材质字典 `main_material_arr` 当成该商品实际材质。
- 父编号、国家到包装版本映射、箱内尺寸、空箱皮重、限重、禁混规则仍需核实；未知值不补0，不凭字段名推断。遇403应报告权限缺口，不更换身份绕过。
