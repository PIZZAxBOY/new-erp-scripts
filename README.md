# new-erp-mcp

本地 stdio MCP 服务与 JavaScript API，用于查询 ERP 商品、销量、订单、库存、装箱、配货及物流数据。需要 Node.js 20+。

## MCP 安装与启动

全局安装后可用 Codex 注册：

```sh
npm install -g new-erp-mcp
codex mcp add new-erp -- new-erp-mcp
```

其他 stdio 客户端可配置：

```json
{
  "mcpServers": {
    "new-erp": {
      "command": "new-erp-mcp",
      "args": []
    }
  }
}
```

也可在客户端配置 `npx -y new-erp-mcp`：

```json
{
  "mcpServers": {
    "new-erp": {
      "command": "npx",
      "args": ["-y", "new-erp-mcp"]
    }
  }
}
```

旧的 `new-erp` 命令行子命令和随包技能已移除。请删除旧 MCP 配置并按上例重新注册、重启客户端；保存在包目录之外的登录会话会保留。唯一安装的可执行入口是 MCP 服务 `new-erp-mcp`，不接受命令行参数。

## 发现与执行

服务仅提供 `erp_discover` 与 `erp_execute` 两个 MCP 工具。先发现参数，再执行操作：

```json
{"query":"商品 ASIN"}
{"operation":"product_detail"}
```

发现结果包含 25 项业务操作和 7 项本机辅助操作。业务能力覆盖商品与分类、SKU 图集、ASIN、销量、市场订单、库存、备货、装箱、配货、物流与导出。辅助操作为 `auth.login`、`auth.status`、`auth.logout`、`jobs.status`、`jobs.list`、`jobs.resume`、`jobs.cancel`。

```json
{"operation":"product_detail","params":{"asin":"B012345678"}}
```

按精确 SKU 查看图片管理页全部图集（含包装版本）：

```json
{"operation":"product_images","params":{"sku":"DEMO-SKU-001"}}
```

返回六组图片的完整 URL、分类和主图标记；任一组失败则整体报错。仅查询链接，不下载、上传或删除图片。详见 [图集 API](docs/api.md#按-sku-查询完整图集)。

查销量、热销或前 N 名时直接发现 `sales_volume_ranking`（支持“销售”“销量”“排名”“热销”等关键词），无需先运行 `category_summary`。销量排名默认顶级物料；显式 `productTypeCate: "6"` 查二级物料，`""` 查全部类型。默认异步导出完整 CSV 后解析排序，MCP 必须携带稳定 `requestId` 并轮询同一任务；Top 10 用 `page: 1, pageSize: 10, fetchAll: false` 控制最终返回条数，不减少导出量。可显式 `source: "list"` 使用旧列表接口。分类工具只计数记录行数且抓取全部分页，不是销量排行。详见 [销量工具选择与查询成本](docs/mcp.md#销量工具选择与查询成本)。

首次使用时通过 `erp_execute` 调用 `auth.login`。MCP 返回本机临时网页地址，由用户亲自输入 ERP 地址、账号和密码；Agent 不查看、不填写或传递密码。服务只保存私有本机会话中的 token，不保存密码。若页面过期，再次调用 `auth.login`。使用 `auth.logout` 删除本机会话；不会撤销 ERP 上游 token。

导出以异步任务运行。使用稳定的 `requestId` 避免重复提交，通过 `jobs.status` 或 `jobs.list` 查询；装箱导出可用 `jobs.resume` 按原范围恢复。导出文件保存在本地受限任务目录，不接受调用方指定路径。

## JavaScript API

自定义消费者可从包导入业务 API：

```js
import { gameProductList, productDetail } from 'new-erp-mcp';

const products = await gameProductList({ sku: 'DEMO-SKU-001' });
const detail = await productDetail({ asin: 'B012345678' });
```

API 函数名、参数与返回契约保持稳定。底层 `erpClient` 可用于自定义分页查询。配置 `NEW_ERP_BASE_URL`，并按调用场景提供 token 或使用项目配置；MCP 查询只使用本机私有登录会话，不回退到共享配置中的 token 或账号密码。详见 [API 文档](./docs/api.md)。

## 使用边界

- 示例 SKU、订单号、ID、ASIN、项目和仓库均为占位符；先确认访问权限和查询范围。
- 查询操作只读取 ERP 业务数据；导出会创建 ERP 下载任务及本地文件，但不创建或修改业务单据。
- ERP 搜索可能模糊匹配。核对返回的 SKU、ASIN、国家、状态与时间范围；不要把不同批次、BOM 或包装版本自动合并。
- `found` 只表示搜索有返回，不保证 SKU 精确命中；分页结果应检查总数和完整性标记。计划/预计数据不等于实际入库或签收凭证。
- 重量、尺寸和数量按 ERP 原始字段及单位保留，不猜测或补齐缺失值。原始响应可能含敏感业务信息，分享前应检查并脱敏。
- 只查询明确授权的数据。不要把密码、token 或会话文件写入对话、日志或版本库。

## 市场订单与 ASIN 契约

市场订单使用只读 `GET /marketing/market-order/index`；ASIN 搜索流程及证据见 [ASIN 接口契约](./docs/erp-asin-contract.md)。端点与字段依据 ERP 前端及接口文档核对。
