---
name: new-erp-scripts
description: "通过命令行查询和导出 new-erp 商品、销量、库存、配货及装箱数据。选择命令、读取分页结果、核对数据口径并恢复导出任务。"
---
# new-erp

示例中的 `DEMO-*` 和商品 ID 均为占位值，查询前替换为实际值；项目和仓库从实时枚举获取。

`new-erp-scripts` 提供 ERP 查询和导出命令，不创建或修改业务单据；导出会在 ERP 下载中心创建任务。

```sh
new-erp-game-product-list --help
new-erp-game-product-list --sku DEMO-SKU-001
new-erp-options --source packing
```

按 [命令与数据口径](references/query-guide.md#命令选择) 选择能力，再用对应命令的 `--help` 确认输入。选项支持 `--option value` 和 `--option=value`。涉及销量汇总、实际入库、库存、BOM/包装版本或重量换算时，先读参考中的对应口径。

## 结果

成功结果写入 stdout，通常是 JSON 数组或对象；列表以 `list` 保存记录。失败在 stderr 输出错误并以非零状态退出，不能把失败当作空结果。`packing-order-pages` 输出 NDJSON，每页一行，按行解析。

装箱、历史配货、批次、外包装、库存、物流渠道及报关列表返回 `totalCount/fetchedCount/complete/source`。默认第1页20条；全量查询传 `--fetchAll`，并从第1页开始。`--pageSize` 最多100，`--maxPages` 默认100、最多1000。检查完整性，保留分页异常，不把单页或截断结果当作全量。

库存预测量不是实际签收量，计划单不是完成凭证；保留不同批次、BOM和包装版本，不自动选首条。尺寸重量保留来源原值，未知单位或数量不补造。具体字段见 [数据口径](references/query-guide.md#装箱数据口径)。

## 装箱与导出

```sh
new-erp-packing-order-list --packingNo YOUR-ORDER --stockFrom DEMO-FROM --fetchAll
new-erp-packing-order-pages --project DEMO-PROJECT --warehouses DEMO-DEST --startDate 2026-07-01 --endDate 2026-09-30 --pageSize 100
```

列表支持精确总单号，或完整的项目、目的仓、开始及结束日期；历史四项只要传一项就必须齐全。`--stockFrom` 只能收窄查询。逐页命令从第1页串行读取，不传 `--fetchAll`；大范围按项目、月份拆分。

装箱明细导出仍需完整历史四项及 `--output`，不覆盖已有文件。默认匹配本次新任务；`--taskId` 只恢复指定任务，必须提供原完整查询，结果是原任务快照。已出库箱优先批量导出，仅为未出库箱或缺失字段补读单箱明细。单箱查询使用列表原箱号、发货仓、状态和目的仓，状态允许0。恢复、轮询及 API 用法见 [装箱历史与导出](references/query-guide.md#装箱历史与导出)。

## 安装与直接运行

需要 Node.js 18+。已有 CLI 时直接调用；未安装时可从 GitHub 直接运行：

```sh
npx --package="git+https://github.com/PIZZAxBOY/new-erp-scripts.git" new-erp-game-product-list --help
```

替换末尾命令和选项即可查询。经常使用时用 `npm install -g "git+https://github.com/PIZZAxBOY/new-erp-scripts.git"` 安装；已有源码也可在仓库根目录执行 `npm install -g .` 或 `node scripts/<command>.js`。GitHub 方式需要 Git，可通过 HTTPS 访问公开仓库；固定版本可在地址末尾追加 `#<提交号或标签>`。

单独安装本技能不会安装运行代码。不要从技能目录推断脚本路径。

## 配置与认证

配置来自运行命令时当前目录的 `config.json`，或 `NEW_ERP_CONFIG` 指定的文件。支持 `baseUrl/username/password/token`，对应的 `NEW_ERP_BASE_URL/NEW_ERP_USERNAME/NEW_ERP_PASSWORD/NEW_ERP_TOKEN` 环境变量优先。认证先用显式 token，再用环境变量或配置中的 token，最后才登录。

缺少配置时说明缺少哪些字段，引导用户在本地配置文件或环境变量中填写；不要要求用户在聊天中发送密码或 token。查询结果及导出文件保留业务原文，对外分享前另行脱敏。
