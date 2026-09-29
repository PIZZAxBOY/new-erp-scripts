# new-erp 脚本

用于查询 new-erp API 的 Node.js 命令行脚本，并附带一个指导代理选择脚本、读取输出的技能。

## 作为 npm 命令行包安装

需要 Node.js 18 或更高版本。可从本仓库安装：

```bash
npm install -g .
new-erp-game-product-list --help
new-erp-game-product-list --sku PFLED
```

发布到 npm 后，也可用 `npm install -g new-erp-scripts` 安装。每个脚本对应一个 `new-erp-<脚本名>` 命令，例如 `new-erp-product-detail`、`new-erp-sales-volume-ranking` 和 `new-erp-supply-evidence`。配置仍从当前工作目录的 `config.json` 或 `NEW_ERP_*` 环境变量读取；不要把认证信息放进 npm 包。

## 在 JavaScript 中导入

在项目里执行 `npm install <本仓库路径>`，然后使用 ES module：

```js
import { gameProductList, salesVolumeRanking } from 'new-erp-scripts';

const products = await gameProductList({ sku: 'PFLED' });
const sales = await salesVolumeRanking({ startDate: '2026-01-01', endDate: '2026-01-31' });
```

函数接收与命令行同名的选项对象，直接返回结果或抛出错误。还导出 `catalogList`、`categorySummary`、`gameProductBatch`、`productDetail`、`salesVolumeExport`、`supplyEvidence` 和 `stockingAssemblyInbound`。配置仍使用当前工作目录的 `config.json` 或 `NEW_ERP_*` 环境变量。

## 安装技能

从本地仓库安装：

```bash
npx skills add . --skill new-erp-scripts --agent codex
```

从 GitHub 安装：

```bash
npx skills add <owner>/<repo> --skill new-erp-scripts --agent codex
```

`skills` CLI 会把技能说明和随附脚本安装到技能目录中。

## 配置

需要 Node.js 18 或更高版本。可以使用环境变量，也可以在项目根目录创建不提交到版本库的 `config.json`：

```json
{
  "baseUrl": "https://your-erp.example.com",
  "token": "your-token"
}
```

环境变量会覆盖配置文件中的值：

```bash
export NEW_ERP_BASE_URL="https://your-erp.example.com"
export NEW_ERP_TOKEN="your-token"
```

需要使用其他配置文件时，设置 `NEW_ERP_CONFIG=/path/to/config.json`。用户名和密码可以通过 `NEW_ERP_USERNAME` 与 `NEW_ERP_PASSWORD` 提供。不要让认证信息进入 Shell 历史记录或版本库。

## 运行

```bash
node .agents/skills/new-erp-scripts/scripts/catalog-list.js --help
node .agents/skills/new-erp-scripts/scripts/game-product-list.js --sku PFLED
node .agents/skills/new-erp-scripts/scripts/game-product-batch.js --skus 'SKU-A,SKU-B'
node .agents/skills/new-erp-scripts/scripts/product-detail.js --id 140496
node .agents/skills/new-erp-scripts/scripts/sales-volume-ranking.js --startDate 2026-01-01 --endDate 2026-01-31
node .agents/skills/new-erp-scripts/scripts/sales-volume-ranking.js --startDate 2026-01-01 --endDate 2026-01-31 --sku AXKNTM004 --aggregateBy sku-platform
node .agents/skills/new-erp-scripts/scripts/sales-volume-export.js --startDate 2026-01-01 --endDate 2026-01-31 --aggregateBy platform --output ./platform-2026-01.csv
node .agents/skills/new-erp-scripts/scripts/supply-evidence.js --source plan --sku AXKNTM004 --startDate 2026-01-01 --endDate 2026-03-31 --fetchAll
node .agents/skills/new-erp-scripts/scripts/stocking-assembly-inbound.js --sku AXKNTM004 --startDate 2026-08-30 --endDate 2026-09-28
node .agents/skills/new-erp-scripts/scripts/category-summary.js --startDate 2026-01-01 --endDate 2026-01-31
```

命令会把 JSON 数组写入 stdout，把错误信息写入 stderr。父级分类会使用 ERP 实时分类树自动展开。

`supply-evidence.js` 的 `--source` 还支持 `move`、`inventory`、`assembly`、`cargo`。单据查询默认只取一页；完整核对请加 `--fetchAll`。`plan` 和 `move` 的数量来自单据明细，不使用列表行的 `num`；搬运计划不代表调库完成。`sales-volume-export.js` 通过下载中心异步导出，保留 ERP 的 GBK CSV。

`stocking-assembly-inbound.js` 按精确 SKU 和入库时间汇总“备货拼装”实际入库流水，用拼装单号核对生产任务。它只统计备货拼装，不包含采购进货或调库。

## 验证

```bash
node --test test/standalone-cli.test.js
for file in .agents/skills/new-erp-scripts/scripts/*.js; do node --check "$file"; done
```

安装方式和仓库约定见 [skills.sh 文档](https://www.skills.sh/docs)。
