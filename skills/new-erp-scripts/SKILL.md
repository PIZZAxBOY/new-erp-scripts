---
name: new-erp-scripts
description: "直接使用 new-erp CLI 查询、批量导出 ERP 数据，处理分页、数据口径和任务恢复。通过 MCP 工具查询时无需加载本技能。"
---
# new-erp

本技能是可选的 CLI 指引，MCP 用户无需安装或加载。

示例中的 `DEMO-*` 和商品 ID 均为占位值，查询前替换为实际值；项目和仓库从实时枚举获取。

`new-erp-mcp` 提供 ERP 查询和导出命令，不创建或修改业务单据；导出会在 ERP 下载中心创建任务。

CLI 统一使用 `new-erp <subcommand>`。先运行 `new-erp --help` 发现命令，再用 `new-erp <subcommand> --help` 查看参数。

按 ASIN 查询商品和图片使用 `new-erp product-detail --asin <10位ASIN>`；与 `--id` 二选一。查询使用当前 ERP 登录，先搜 ERP Listing，再按精确 SKU 取商品详情，保留全部商品及店铺匹配。图片来自 ERP 的 `imageUrl`，不访问亚马逊公开页面或其他 ERP。

```sh
new-erp game-product-list --help
new-erp game-product-list --sku DEMO-SKU-001
new-erp options --source packing
```

按 [命令与数据口径](references/query-guide.md#命令选择) 选择能力，再用对应命令的 `--help` 确认输入。选项支持 `--option value` 和 `--option=value`。涉及销量汇总、实际入库、库存、BOM/包装版本或重量换算时，先读参考中的对应口径。

## 结果

成功结果写入 stdout，通常是 JSON 数组或对象；列表以 `list` 保存记录。失败在 stderr 输出错误并以非零状态退出，不能把失败当作空结果。`packing-order-pages` 输出 NDJSON，每页一行，按行解析。

市场订单、装箱、历史配货、批次、外包装、库存、物流渠道及报关列表返回 `totalCount/fetchedCount/complete/source`。默认第1页20条；全量查询传 `--fetchAll`，并从第1页开始。`--pageSize` 最多100，`--maxPages` 默认100、最多1000。检查完整性，保留分页异常，不把单页或截断结果当作全量。

库存预测量不是实际签收量，计划单不是完成凭证；保留不同批次、BOM和包装版本，不自动选首条。尺寸重量保留来源原值，未知单位或数量不补造。具体字段见 [数据口径](references/query-guide.md#装箱数据口径)。

## 装箱与导出

```sh
new-erp packing-order-list --packingNo YOUR-ORDER --stockFrom DEMO-FROM --fetchAll
new-erp packing-order-pages --project DEMO-PROJECT --warehouses DEMO-DEST --startDate 2026-07-01 --endDate 2026-09-30 --pageSize 100
```

列表支持精确总单号，或完整的项目、目的仓、开始及结束日期；历史四项只要传一项就必须齐全。`--stockFrom` 只能收窄查询。逐页命令从第1页串行读取，不传 `--fetchAll`；大范围按项目、月份拆分。

装箱明细导出仍需完整历史四项及 `--output`，不覆盖已有文件。默认匹配本次新任务；`--taskId` 只恢复指定任务，必须提供原完整查询，结果是原任务快照。已出库箱优先批量导出，仅为未出库箱或缺失字段补读单箱明细。单箱查询使用列表原箱号、发货仓、状态和目的仓，状态允许0。恢复、轮询及 API 用法见 [装箱历史与导出](references/query-guide.md#装箱历史与导出)。

## 安装与直接运行

需要 Node.js 20+。已有 CLI 时直接调用；未安装时可从 npm 直接运行：

```sh
npx --package=new-erp-mcp new-erp game-product-list --help
```

替换末尾命令和选项即可查询。经常使用时用 `npm install -g new-erp-mcp` 安装；已有源码也可在仓库根目录执行 `npm install -g .` 或 `node scripts/new-erp.js <command>`。固定版本可使用 `new-erp-mcp@0.3.1`。

单独安装本技能不会安装运行代码。不要从技能目录推断脚本路径。

## 配置与认证

推荐启动 `new-erp login --browser` 并保持进程运行，让用户在本机临时网页一次填写 ERP 网址、账号和密码；不要查看或填写真实密码字段。无法自动打开时，把命令输出的链接交给用户。登录仅保存本机会话，成功、取消或 5 分钟过期后关闭临时服务；`new-erp logout` 删除本机会话。

网页登录不可用时，先确认 ERP 地址，再用 `new-erp login --baseUrl <ERP地址>`。客户端支持 `request_secret` 时可用私密输入卡，临时文件由本地进程读取，经 `NEW_ERP_PASSWORD` 传给命令并在完成后删除；否则让用户在终端隐藏输入密码。不得把密码内容读入模型上下文、日志或命令参数。登录成功后重试原查询。

CLI/API 还支持当前目录的 `config.json`，或 `NEW_ERP_CONFIG` 指定的文件。支持 `baseUrl/username/password/token`，对应环境变量优先。认证先用显式 token，再用环境变量或项目配置中的 token，然后用地址匹配且未过期的本机会话，最后才尝试账号密码登录。`NEW_ERP_SESSION_FILE` 可指定会话文件路径。不要在模型工具参数中传密码或 token。

缺少配置时，允许主动询问用户的 ERP 网址（`baseUrl`）、登录账号（`username`）和密码（`password`），只询问尚未提供的字段；已有可用 token 时无需再询问账号密码。网址和账号可在对话中询问，密码或 token 使用平台提供的私密输入工具（如 `request_secret`）收集；没有私密输入工具时，引导用户在本地配置文件或环境变量中填写。

认证信息仅用于用户指定的 ERP，不在回复、日志或示例中回显密码和 token，不提交到版本库。查询结果及导出文件保留业务原文，对外分享前另行脱敏。
