# new-erp-scripts

> 通过命令行和 JavaScript 查询 new-erp 数据，供人和 AI Agent 使用。

覆盖商品、销量、库存、配货、装箱和物流申报。查询结果可直接处理为 JSON，批量导出保留 ERP 原生 CSV/XLSX；支持完整分页、逐页读取和装箱导出任务恢复。

所有命令只查询或导出数据，不创建或修改业务单据。导出会在 ERP 下载中心创建任务。

## 快速开始

以下 SKU、ID、项目及仓库均为脱敏示例；使用时替换为有权限访问的真实值。项目和仓库代码可通过 `new-erp-options` 查询。

### 1. 安装命令行工具

需要 Node.js 18+ 和 Git。代码仓库公开，可直接通过 HTTPS 安装；查询 ERP 数据仍需自行配置认证信息。

```sh
node --version
npm install -g "git+https://github.com/PIZZAxBOY/new-erp-scripts.git"
new-erp-game-product-list --help
```

也可以通过 `npx` 直接运行，替换末尾命令和选项即可：

```sh
npx --package="git+https://github.com/PIZZAxBOY/new-erp-scripts.git" new-erp-game-product-list --help
```

需要固定版本时，在 Git 地址末尾追加 `#<提交号或标签>`。

### 2. 配置 ERP

在运行命令的目录创建不提交到版本库的 `config.json`：

```json
{
  "baseUrl": "https://your-erp.example.com",
  "token": "your-token"
}
```

也可通过环境变量或其他配置文件提供，见 [配置与认证](#配置与认证)。不要把真实 token、密码放进聊天、命令行历史或版本库。

### 3. 执行查询

```sh
new-erp-game-product-list --sku DEMO-SKU-001
new-erp-product-detail --id 12345
new-erp-sales-volume-ranking --startDate 2026-01-01 --endDate 2026-01-31
```

## 命令行使用

每个命令都支持 `--help`、`--option value` 和 `--option=value`。先查看帮助确认所需参数。

```sh
# 批量查商品
new-erp-game-product-batch --skus 'SKU-A,SKU-B'

# 查国内仓的库存批次与 BOM
new-erp-inventory-list --sku DEMO-SKU-003 --stockCode DEMO-STOCK --fetchAll

# 按总单号查询装箱列表
new-erp-packing-order-list --packingNo YOUR-ORDER --stockFrom DEMO-FROM --fetchAll

# 导出平台销量，保留 ERP 的 GBK CSV
new-erp-sales-volume-export --startDate 2026-01-01 --endDate 2026-01-31 --aggregateBy platform --output ./platform-2026-01.csv
```

成功结果写入 stdout，通常为 JSON 数组或对象；错误写入 stderr，并以非零状态退出。`new-erp-packing-order-pages` 每页输出一行 JSON（NDJSON），需按行处理。

装箱、配货、库存等列表默认第1页20条，返回 `list/totalCount/fetchedCount/complete/source`。完整查询使用 `--fetchAll` 并从第1页开始；`--pageSize` 最多100，`--maxPages` 默认100、最多1000。分页截断、重复记录或总数变化会报错。

大范围装箱历史可逐页读取，按项目和月份拆分：

```sh
new-erp-packing-order-pages --project DEMO-PROJECT --warehouses DEMO-DEST --startDate 2026-07-01 --endDate 2026-07-31 --pageSize 100
new-erp-packing-detail-export --project DEMO-PROJECT --warehouses DEMO-DEST --startDate 2026-07-01 --endDate 2026-07-31 --output ./packing-2026-07.xlsx
```

装箱列表支持精确总单号查询；批量明细导出仍需完整的项目、目的仓、开始和结束日期。导出不覆盖已有文件，装箱导出可用 `--taskId` 恢复原任务。范围限制和数据口径见 [查询指南](./skills/new-erp-scripts/references/query-guide.md)。

## 供 AI Agent 使用

安装技能，让 Agent 按需选命令、处理分页并核对数据口径：

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
npm install "git+https://github.com/PIZZAxBOY/new-erp-scripts.git"
```

通过 ES module 导入，选项与 CLI 同名：

```js
import { gameProductList, salesVolumeRanking } from 'new-erp-scripts';

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

环境变量覆盖配置文件中的同名值。所有查询和导出优先使用显式 token，再使用环境变量或配置中的 token，最后才登录。

错误信息对认证字段做脱敏，不回显非 JSON 响应正文或配置解析原文。查询结果及导出文件保留 ERP 业务原文，对外分享前需另行脱敏。

认证请求和文件下载拒绝 HTTP 重定向。JSON 请求默认最多等待120秒，包含正文读取；装箱导出任务默认等待20分钟，可通过 `timeoutMs` 调整。具体轮询和超时边界见 [API 文档](./docs/api.md#装箱历史与批量导出)。

## 命令一览

| 范围 | 命令 |
| --- | --- |
| 商品与分类 | `new-erp-catalog-list`、`new-erp-game-product-list`、`new-erp-game-product-batch`、`new-erp-product-detail` |
| 销量与汇总 | `new-erp-sales-volume-ranking`、`new-erp-sales-volume-export`、`new-erp-category-summary` |
| 单据与实际入库 | `new-erp-supply-evidence`、`new-erp-stocking-assembly-inbound` |
| 装箱历史与导出 | `new-erp-packing-order-list`、`new-erp-packing-order-pages`、`new-erp-packing-detail`、`new-erp-packing-detail-export` |
| 配货批次与历史明细 | `new-erp-packing-batch-list`、`new-erp-packing-batch-detail`、`new-erp-plan-delivery-order-list` |
| 库存与包装 | `new-erp-inventory-list`、`new-erp-outer-package-list` |
| 物流、申报与枚举 | `new-erp-logistics-channel-list`、`new-erp-product-declaration-list`、`new-erp-options` |

各命令的必填选项和适用场景见 [查询指南](./skills/new-erp-scripts/references/query-guide.md#命令选择)。库存预测量、计划单据、BOM 版本和重量单位各有不同口径，汇总前请核对来源。

## 开发与验证

```text
scripts/                    # CLI 与共享客户端
index.mjs                   # JavaScript API 导出
skills/new-erp-scripts/      # Agent 技能与查询指南
docs/                       # API 与数据口径
test/                       # 自动化测试
```

在仓库根目录可用 `node scripts/<command>.js` 运行，或用 `npm install -g .` 安装本地版本。验证命令：

```sh
npm test
node --check index.mjs
for file in scripts/*.js; do node --check "$file"; done
```
