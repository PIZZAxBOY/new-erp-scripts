# new-erp 脚本

用于查询 new-erp API 的 Node.js 命令行脚本，并附带一个指导代理选择脚本、读取输出的技能。

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
node .agents/skills/new-erp-scripts/scripts/category-summary.js --startDate 2026-01-01 --endDate 2026-01-31
```

命令会把 JSON 数组写入 stdout，把错误信息写入 stderr。展开父级分类需要 `NEW_ERP_CATALOG_MAP` 或 `config.catalogMap`。

## 验证

```bash
node --test test/standalone-cli.test.js
for file in .agents/skills/new-erp-scripts/scripts/*.js; do node --check "$file"; done
```

安装方式和仓库约定见 [skills.sh 文档](https://www.skills.sh/docs)。
