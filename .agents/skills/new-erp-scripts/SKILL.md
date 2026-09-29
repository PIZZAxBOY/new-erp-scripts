---
name: new-erp-scripts
description: "当用户需要查询 new-erp 数据、搜索商品、查看商品详情、统计销量或按分类汇总时，使用 scripts/ 中的独立 Node.js 命令行脚本。"
---

# 使用 new-erp 脚本

使用技能附带的脚本处理用户提出的 new-erp 数据查询。这些脚本只读，使用 Node.js 内置功能。将 `SKILL_DIR` 设置为包含此 `SKILL.md` 的目录，然后使用 Node.js 18 或更高版本运行 `scripts/` 下对应的文件。

## 运行前

- 使用已配置的 ERP 地址。项目根目录中的 `config.json` 可提供默认值，`NEW_ERP_BASE_URL` 会覆盖其中的 `baseUrl`。需要使用其他 JSON 配置文件时，设置 `NEW_ERP_CONFIG`。
- 配置文件支持 `baseUrl`、`username`、`password` 和 `token`。对应的环境变量是 `NEW_ERP_BASE_URL`、`NEW_ERP_USERNAME`、`NEW_ERP_PASSWORD` 和 `NEW_ERP_TOKEN`，环境变量优先。
- 优先使用 token。不要打印、回显或提交认证信息。
- 如果缺少 ERP 地址或认证信息，先向用户索取，不要猜测主机地址。
- 不确定选项时，使用 `node "$SKILL_DIR/scripts/<command>.js" --help` 查看帮助。在当前仓库中，`SKILL_DIR=.agents/skills/new-erp-scripts`。

## 选择命令

| 用户需求 | 命令 |
| --- | --- |
| 查找商品分类或分类 ID | `node "$SKILL_DIR/scripts/catalog-list.js"` |
| 按 SKU、中文名称、类型或分类搜索商品 | `node "$SKILL_DIR/scripts/game-product-list.js"` |
| 一次查询多个 SKU | `node "$SKILL_DIR/scripts/game-product-batch.js"` |
| 按商品 ID 查看单个商品 | `node "$SKILL_DIR/scripts/product-detail.js"` |
| 按日期范围统计 SKU 销量排名，精确查 SKU 或按 SKU+平台拆分 | `node "$SKILL_DIR/scripts/sales-volume-ranking.js"` |
| 大范围异步导出 SKU、SKU+平台或平台销量 CSV | `node "$SKILL_DIR/scripts/sales-volume-export.js"` |
| 查询销售计划、搬运计划、成品出入库、组装计划或货物流转单据 | `node "$SKILL_DIR/scripts/supply-evidence.js"` |
| 按 SKU 和日期统计备货拼装的实际入库数量 | `node "$SKILL_DIR/scripts/stocking-assembly-inbound.js"` |
| 按 ERP 分类统计匹配的 SKU 销售记录数 | `node "$SKILL_DIR/scripts/category-summary.js"` |

所有命令支持 `--option value`、`--option=value` 和 `--help`。成功结果会以 JSON 数组写入 stdout，错误信息会写入 stderr，并以非零状态退出。

## 常用用法

```bash
SKILL_DIR=.agents/skills/new-erp-scripts
node "$SKILL_DIR/scripts/catalog-list.js" --keyword 游戏内配
node "$SKILL_DIR/scripts/game-product-list.js" --sku PFLED
node "$SKILL_DIR/scripts/game-product-batch.js" --skus 'SKU-A,SKU-B'
node "$SKILL_DIR/scripts/product-detail.js" --id 140496
node "$SKILL_DIR/scripts/sales-volume-ranking.js" --startDate 2026-01-01 --endDate 2026-01-31
node "$SKILL_DIR/scripts/sales-volume-ranking.js" --startDate 2026-01-01 --endDate 2026-01-31 --sku AXKNTM004 --aggregateBy sku-platform
node "$SKILL_DIR/scripts/sales-volume-export.js" --startDate 2026-01-01 --endDate 2026-01-31 --aggregateBy platform --output ./platform-2026-01.csv
node "$SKILL_DIR/scripts/supply-evidence.js" --source plan --sku AXKNTM004 --startDate 2026-01-01 --endDate 2026-03-31 --fetchAll
node "$SKILL_DIR/scripts/supply-evidence.js" --source move --sku AXKNTM004 --startDate 2026-01-01 --endDate 2026-03-31 --fetchAll
node "$SKILL_DIR/scripts/supply-evidence.js" --source inventory --sku AXKNTM004 --startDate 2026-01-01 --endDate 2026-03-31 --fetchAll
node "$SKILL_DIR/scripts/supply-evidence.js" --source assembly --sku AXKNTM004 --fetchAll
node "$SKILL_DIR/scripts/supply-evidence.js" --source cargo --sku AXKNTM004 --fetchAll
node "$SKILL_DIR/scripts/stocking-assembly-inbound.js" --sku AXKNTM004 --startDate 2026-08-30 --endDate 2026-09-28
node "$SKILL_DIR/scripts/category-summary.js" --startDate 2026-01-01 --endDate 2026-01-31
```

只填写日期时，开始时间使用 `00:00:00`，结束时间使用 `23:59:59`。`sales-volume-ranking` 默认返回 ERP 排序后的一个分页。需要完整结果并重新排序时，使用 `--fetchAll true`。`category-summary` 始终获取整个匹配范围，统计的是记录行数，不是销售数量。

销量接口的 `sku` 是前缀查询；排行脚本传 `--sku` 时会自动抓取全部匹配页，再按 SKU 精确过滤。`--aggregateBy sku-platform` 可查看平台拆分；平台整体汇总请用异步导出，CSV 保持 ERP 的 GBK 编码。导出脚本会复用下载中心的同条件任务，不覆盖已有文件。

`supply-evidence` 的 `plan` 和 `move` 会用列表中的 `id` 和 `confirmed_no` 读取单据明细，只返回明细 SKU 精确匹配的计划数量 `plannedNum`；列表行的 `num` 不是整单数量。`inventory` 返回成品出入库记录，`assembly` 和 `cargo` 返回备货候选记录。后两者的 ERP 日期筛选不可靠，因此脚本不提供日期参数。默认只抓一页；需要完整结果时传 `--fetchAll`。库存实时字段、搬运计划及调库申请/过渡仓记录不能视为历史库存或目的仓签收。

`stocking-assembly-inbound` 将成品入库流水按拼装单号与类型为“备货拼装”的生产任务关联，仅汇总所选时间内实际入库的精确 SKU 数量；采购进货和调库另属其他流程。

单个父级分类 ID 会使用 ERP 实时分类树自动展开。

## 修改脚本时

修改脚本时复用 `scripts/shared.js`。修改后运行：

```bash
SKILL_DIR=.agents/skills/new-erp-scripts
node --test test/standalone-cli.test.js
for file in "$SKILL_DIR/scripts"/*.js; do node --check "$file"; done
```

除非用户明确要求项目工具配置，否则不要新增格式化工具或代码检查工具的配置。
