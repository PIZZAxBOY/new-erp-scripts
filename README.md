# new-erp-mcp

> 通过命令行、JavaScript 和本地 MCP 查询 new-erp 数据，供人和 AI Agent 使用。

覆盖商品、销量、市场订单、库存、配货、装箱和物流申报。商品图片来自 ERP。查询结果可直接处理为 JSON，批量导出保留 ERP 原生 CSV/XLSX；支持完整分页、逐页读取和装箱导出任务恢复。

业务命令只查询或导出数据，不创建或修改业务单据。导出会在 ERP 下载中心创建任务；登录和客户端接入命令仅修改本机文件。

## 快速开始

以下 SKU、ID、项目及仓库均为脱敏示例；使用时替换为有权限访问的真实值。项目和仓库代码可通过 `new-erp options` 查询。

### 1. 安装命令行工具

需要 Node.js 20+。npm 包名为 `new-erp-mcp`，安装后使用 `new-erp` 命令。也支持 `npm install -g ./new-erp-mcp-0.3.0.tgz` 安装下载的 npm 包。

```sh
node --version
npm install -g new-erp-mcp
new-erp game-product-list --help
```

也可以通过 `npx` 直接运行，替换末尾命令和选项即可：

```sh
npx --package=new-erp-mcp new-erp game-product-list --help
```

需要固定版本时使用 `new-erp-mcp@0.3.0`。

### 2. 配置 ERP

推荐打开本机临时网页登录，一次填写 ERP 网址、账号和密码：

```sh
new-erp login --browser
```

登录只保存 token，不保存密码，后续 CLI 与本地 MCP 均可使用。运行 `new-erp logout` 删除本机登录会话。

网页登录成功后自动关闭临时服务。MCP 未登录时才返回详细引导，让 Agent 打开登录页并在完成后重试查询；初始化只加载两个入口，业务参数按需发现。也支持 `new-erp login --baseUrl https://your-erp.example.com` 在终端隐藏输入密码，或使用客户端私密输入卡。

已有 token 时，也可在运行命令的目录创建不提交到版本库的 `config.json`：

```json
{
  "baseUrl": "https://your-erp.example.com",
  "token": "your-token"
}
```

也可通过环境变量或其他配置文件提供，见 [配置与认证](#配置与认证)。不要把真实 token、密码放进聊天、命令行历史或版本库。

### 3. 执行查询

```sh
new-erp game-product-list --sku DEMO-SKU-001
new-erp product-detail --id 12345
new-erp product-detail --asin B012345678
new-erp sales-volume-ranking --startDate 2026-01-01 --endDate 2026-01-31
```

## 命令行使用

所有已安装命令统一通过 `new-erp <subcommand>` 调用。运行 `new-erp --help` 查看可用命令和简要说明，运行 `new-erp <subcommand> --help` 查看具体参数。迁移提示：原来独立调用 `new-erp-foo` 的方式改为 `new-erp foo`；安装包仅提供统一入口。

每个命令都支持 `--help`、`--option value` 和 `--option=value`。先查看帮助确认所需参数。

```sh
# 批量查商品
new-erp game-product-batch --skus 'SKU-A,SKU-B'

# 查市场订单：默认搜索系统单号；searchType 6 按 SKU 搜索
new-erp market-order-list --searchValue DEMO-ORDER-ID
new-erp market-order-list --searchType 6 --searchValue DEMO-SKU-001 --fetchAll

# 查国内仓的库存批次与 BOM
new-erp inventory-list --sku DEMO-SKU-003 --stockCode DEMO-STOCK --fetchAll

# 按总单号查询装箱列表
new-erp packing-order-list --packingNo YOUR-ORDER --stockFrom DEMO-FROM --fetchAll

# 导出平台销量，保留 ERP 的 GBK CSV
new-erp sales-volume-export --startDate 2026-01-01 --endDate 2026-01-31 --aggregateBy platform --output ./platform-2026-01.csv
```

成功结果写入 stdout，通常为 JSON 数组或对象；错误写入 stderr，并以非零状态退出。`new-erp packing-order-pages` 每页输出一行 JSON（NDJSON），需按行处理。

市场订单、装箱、配货、库存等列表默认第1页20条，返回 `list/totalCount/fetchedCount/complete/source`。完整查询使用 `--fetchAll` 并从第1页开始；`--pageSize` 最多100，`--maxPages` 默认100、最多1000。分页截断、重复记录或总数变化会报错。

大范围装箱历史可逐页读取，按项目和月份拆分：

```sh
new-erp packing-order-pages --project DEMO-PROJECT --warehouses DEMO-DEST --startDate 2026-07-01 --endDate 2026-07-31 --pageSize 100
new-erp packing-detail-export --project DEMO-PROJECT --warehouses DEMO-DEST --startDate 2026-07-01 --endDate 2026-07-31 --output ./packing-2026-07.xlsx
```

装箱列表支持精确总单号查询；批量明细导出仍需完整的项目、目的仓、开始和结束日期。导出不覆盖已有文件，装箱导出可用 `--taskId` 恢复原任务。范围限制和数据口径见 [查询指南](./skills/new-erp-scripts/references/query-guide.md)。

## 按 ASIN 查询 ERP 商品和图片

`B012345678` 是示例值，替换为实际 ASIN：

```sh
new-erp product-detail --asin B012345678
```

`--id` 与 `--asin` 二选一。ASIN 查询先读取 ERP 的 Listing 搜索枚举，再搜索匹配的 ERP SKU，最后获取商品详情；图片来自 ERP 的 `imageUrl`。所有请求使用 ERP 登录凭据，不访问亚马逊商品网页。

同一 ASIN 对应多个 SKU 或店铺时保留全部匹配；商品详情附带 `asinListings` 和 `asinSource`。没有匹配、未配对 ERP SKU、权限不足或分页不完整时直接报错。ASIN 和 SKU 搜索默认各自最多100页，每页100条，可用 `--maxPages` 调整，上限1000页。接口和字段见 [ASIN 查询 API](./docs/api.md#按-asin-查询-erp-商品)。

## 在 Codex 中使用本地 MCP

全局安装本包并完成 ERP 登录后，运行：

```sh
new-erp setup --client codex
```

该命令调用本机 `codex mcp add`，将当前 Node.js 和 MCP 入口的绝对路径注册到 Codex，无需手动编辑配置。需要先安装 Codex CLI；会替换同名的 `new-erp` MCP 配置，可用 `--name` 改名或用 `--dryRun` 预览。重启 Codex 后即可在对话中查询。

`new-erp mcp` 只注册 `erp_discover` 和 `erp_execute` 两个入口，按需发现并调用现有全部 24 项业务能力。包括商品、ASIN 图片、销量、订单、库存、装箱、配货、物流和导出；`auth.login` 可直接打开本机配置页，不需要 Agent 执行终端命令。业务只使用保存的个人会话，不读取共享 token。

导出返回任务编号及本地文件路径，长任务不阻塞客户端；参数与完整能力目录通过 `erp_discover` 获取。MCP 用户无需安装 CLI 技能。0.3 起，原四个直接工具改为 `erp_execute` 的业务能力名称。

安装、登录保存位置、手动配置和更新方法见 [本地 MCP 指南](./docs/mcp.md)。

## 可选 CLI 技能

MCP 用户无需安装仓库技能。需要让 Agent 直接使用 CLI、处理批量导出或分页时，可选安装：

```sh
npx skills add PIZZAxBOY/new-erp-scripts --skill new-erp-scripts --agent codex
```

本地仓库可用 `npx skills add . --skill new-erp-scripts --agent codex`。公开仓库可直接远程安装；安装方式见 [skills.sh 文档](https://www.skills.sh/docs)。

安装后可直接向 Agent 描述需求，例如：

> 查询 DEMO-SKU-001 的商品信息。
>
> 导出 DEMO-PROJECT 项目 DEMO-DEST 仓在 2026 年 7 月扫描出库的装箱明细，保存为 XLSX。

技能只包含调用说明，运行代码需独立安装或通过 `npx` 获取。技能入口见 [SKILL.md](./skills/new-erp-scripts/SKILL.md)，完整命令及数据口径见 [查询指南](./skills/new-erp-scripts/references/query-guide.md)。

## JavaScript API

在使用方项目中安装：

```sh
npm install new-erp-mcp
```

通过 ES module 导入，选项与 CLI 同名：

```js
import { gameProductList, salesVolumeRanking } from 'new-erp-mcp';

const products = await gameProductList({ sku: 'DEMO-SKU-001' });
const sales = await salesVolumeRanking({
  startDate: '2026-01-01',
  endDate: '2026-01-31',
  fetchAll: true,
});
```

`packingOrderPages(options)` 提供逐页异步迭代，`exportPackingDetails(options)` 可返回 XLSX Buffer，并通过 `onProgress` 保存任务 ID。底层 `erpClient` 可用于自定义查询。参数、返回值和恢复示例见 [API 文档](./docs/api.md)。

## 配置与认证

| 环境变量 | 配置文件字段 | 用途 |
| --- | --- | --- |
| `NEW_ERP_BASE_URL` | `baseUrl` | ERP 地址 |
| `NEW_ERP_TOKEN` | `token` | 已有 token |
| `NEW_ERP_USERNAME` | `username` | 登录用户名 |
| `NEW_ERP_PASSWORD` | `password` | 登录密码 |
| `NEW_ERP_CONFIG` | 无 | 指定配置文件路径，默认读取当前目录的 `config.json` |
| `NEW_ERP_SESSION_FILE` | 无 | 指定本机登录会话文件路径；默认位于当前系统用户的配置目录 |

环境变量覆盖项目配置文件中的同名值。CLI/API 的 ERP 地址最后回退到本机登录会话；认证先使用显式 token，再使用环境变量或项目配置中的 token，然后使用地址匹配且未过期的本机会话，最后才尝试账号密码登录。MCP 的 ERP 查询始终绑定本机登录会话，不使用上述共享配置回退。

错误信息对认证字段做脱敏，不回显非 JSON 响应正文或配置解析原文。查询结果及导出文件保留 ERP 业务原文，对外分享前需另行脱敏。

认证请求和文件下载拒绝 HTTP 重定向。JSON 请求默认最多等待120秒，包含正文读取；装箱导出任务默认等待20分钟，可通过 `timeoutMs` 调整。具体轮询和超时边界见 [API 文档](./docs/api.md#装箱历史与批量导出)。

## 命令一览

| 范围 | 命令 |
| --- | --- |
| 商品与分类 | `new-erp catalog-list`、`new-erp game-product-list`、`new-erp game-product-batch`、`new-erp product-detail --id/--asin` |
| 登录与本地 MCP | `new-erp login`、`new-erp logout`、`new-erp setup`、`new-erp mcp` |
| 销量与汇总 | `new-erp sales-volume-ranking`、`new-erp sales-volume-export`、`new-erp category-summary` |
| 单据与实际入库 | `new-erp supply-evidence`、`new-erp stocking-assembly-inbound` |
| 装箱历史与导出 | `new-erp packing-order-list`、`new-erp packing-order-pages`、`new-erp packing-detail`、`new-erp packing-detail-export` |
| 配货批次与历史明细 | `new-erp packing-batch-list`、`new-erp packing-batch-detail`、`new-erp plan-delivery-order-list` |
| 库存与包装 | `new-erp inventory-list`、`new-erp outer-package-list` |
| 物流、申报与枚举 | `new-erp logistics-channel-list`、`new-erp product-declaration-list`、`new-erp options` |

各命令的必填选项和适用场景见 [查询指南](./skills/new-erp-scripts/references/query-guide.md#命令选择)。库存预测量、计划单据、BOM 版本和重量单位各有不同口径，汇总前请核对来源。

## 开发与验证

```text
scripts/                    # CLI 与共享客户端
index.mjs                   # JavaScript API 导出
skills/new-erp-scripts/      # Agent 技能与查询指南
docs/                       # API 与数据口径
test/                       # 自动化测试
```

在仓库根目录可用 `node scripts/new-erp.js <command>` 运行，或用 `npm install -g .` 安装本地版本。验证命令：

```sh
npm ci
npm test
npm run check:package
node --check index.mjs
for file in scripts/*.js; do node --check "$file"; done
```
