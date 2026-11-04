# 安装与使用本地 MCP

需要 Node.js 20+。MCP 在用户自己的电脑运行，使用各自的 ERP 登录和权限，无需部署服务器。

## 安装并接入客户端

```sh
npm install -g new-erp-mcp
```

将启动命令配置为标准 stdio MCP。Codex 可用全局安装包手动注册：

```sh
codex mcp add new-erp -- new-erp-mcp
```

也可不全局安装，直接配置 `npx -y new-erp-mcp`。其他支持本地 stdio 的客户端将
`new-erp-mcp`（或 `npx -y new-erp-mcp`）作为启动命令，标准输入和输出仅传输 MCP 协议。
旧版 `new-erp mcp`、`new-erp setup` 配置需要删除并重新注册；保存的登录会话不会丢失。

## 首次在网页完成配置

向 Agent 提出业务需求即可，例如“按 ASIN 查询商品图片”。未登录时，工具返回配置引导，Agent 调用：

```js
erp_execute({ operation: 'auth.login', params: {} })
```

该调用立即返回本机登录链接，并自动尝试打开浏览器。用户在页面一次填写 ERP 网址、账号和密码；不能自动打开时手动打开返回的链接。Agent 不查看或填写真实密码字段。密码由网页直接交给本地程序登录 ERP，不进入对话、工具参数、命令参数或结果，也不会保存。

页面五分钟后失效，成功、取消或过期后关闭临时服务。登录失败可在原页面重试，不会覆盖原会话。Agent 可查询 `auth.status`，登录成功后重试原业务操作，无需重启 MCP。

登录仅通过 MCP 的 `auth.login` 完成。网页不可用时，在返回的本机 URL 中手动打开页面；
不要在聊天正文、工具参数或任何命令参数中提交密码。

## 按需发现能力和参数

初始化只加载两个工具，完整业务参数在需要时返回：

| 工具 | 用法 |
| --- | --- |
| `erp_discover` | `query` 按关键词找能力；`operation` 返回参数、范围/成本提示及可用示例；都省略时列出目录。 |
| `erp_execute` | 用 `operation`、`params` 执行；导出还需稳定的 `requestId`。 |

目录覆盖现有 25 项业务能力：商品与分类、SKU 图集、ASIN 图片、销量与汇总、市场订单、库存与凭证、装箱与配货、外包装、物流与申报，以及全部导出。`auth.*` 和 `jobs.*` 也通过同一个入口按需调用。

```js
erp_discover({ query: '商品' })
erp_discover({ operation: 'product_detail' })
erp_execute({ operation: 'product_detail', params: { asin: 'B012345678' } })
erp_discover({ operation: 'product_images' })
erp_execute({ operation: 'product_images', params: { sku: 'DEMO-SKU-001' } })
```

`product_images` 按精确 SKU 读取图片管理页全部六组图片，保留包装版本、主图/销售主图标记及完整 HTTP(S) 地址。返回 `groups` 分类详情和 `urls` 去重链接；不存在的 SKU、损坏响应或任一组权限错误均报错，不返回残缺的“完整图集”。只返回链接，不提交 ERP 下载任务，也不修改图片。完整范围及字段见 [图集 API](./api.md#按-sku-查询完整图集)。

ASIN 是示例值。其他业务参数以对应的 `erp_discover({ operation })` 结果为准；未知参数、错误类型和凭据参数会被拒绝。查询只使用本机保存的个人会话，不回退到环境或项目中的共享 token。

0.3 起，原四个直接 MCP 工具改为业务能力名称。例如原 `product_detail({ asin })` 改为上面的 `erp_execute` 调用。
JavaScript API 保留原有入口；旧的终端子命令和随包技能已移除。

### 销量工具选择与查询成本

发现支持“销售 / 销量 / 排名 / 排行 / 热销 / Top / SKU”等关键词；销量相关查询优先返回 `sales_volume_ranking`。关键词以空格分隔时须全部匹配，显式用途关键词匹配优先于说明文字的偶然命中；精确 operation 名直接定位该项。不是自然语言语义搜索，未匹配时可缩短关键词或直接指定 operation。

| 需求 | operation | 成本与范围 |
| --- | --- | --- |
| 销量排名、热销前 N 名 | `sales_volume_ranking` | 默认顶级物料；异步导出完整 CSV 后排序截取，无需先查分类 |
| 指定 SKU 销量 | `sales_volume_ranking` | 导出匹配结果后精确过滤，保留平台维度 |
| 各分类的 SKU 记录行数 | `category_summary` | 不是销量/售出件数；总是抓取全部分页，默认每页100条。调小 pageSize 不会限制总条数 |
| 需要销量 CSV 文件 | `sales_volume_export` | 创建异步 ERP 导出任务；不支持 productTypeCate 筛选，不继承排名默认值 |

例如查询 JY 销量前10名，日期请按用户需求替换；默认只统计顶级物料，不必先运行 `category_summary`：

```js
erp_discover({ query: '销量 排名' })
erp_discover({ operation: 'sales_volume_ranking' })
erp_execute({ operation: 'sales_volume_ranking', requestId: 'jy-sales-2026-10-top10', params: {
  startDate: '2026-10-01', endDate: '2026-10-31', auctionSite: 'JY',
  productTypeCate: '5', page: 1, pageSize: 10, fetchAll: false,
  sort: 'sales', order: 'desc'
} })
```

`productTypeCate` 省略时默认 `"5"`（顶级物料）；显式 `"6"` 查询二级物料，显式 `""` 查询全部类型。分类记录计数保持全部类型默认值。排名默认 `source: 'export'`，解析完整 CSV 并全局排序，最后按 page/pageSize 截取；Top10 也需要完整数据，不能承诺更快。远程 HTTP MCP 可复用同一精确查询的短期完整缓存；JS API 和 stdio MCP 每次执行新的导出。`fetchAll: true` 返回全部排名，指定 `sku` 时精确过滤并返回全部匹配结果。远程缓存的权限隔离、数据新鲜度和强制刷新见[远程 MCP 文档](./remote-mcp.md#远程销量缓存)。

通过 `jobs.status` 轮询同一个 jobId；进度包含提交、等待、下载、解析和上游 taskId。重试或轮询使用相同 requestId，不要每次轮询新建导出；远程缓存的强制刷新则必须使用新的 requestId。最长等待约20分钟，CSV 上限64MiB；后台任务失败或 CSV 无法识别会报错，不返回部分排名。实际 CSV 表头尚未用生产导出验证。

短范围需要旧单页接口时可显式设置 `source: 'list'`（MCP 仍要求 requestId）：单页沿用 ERP 原生销量降序，其他排序、SKU 精确查询需要完整分页，maxPages 只对 list 生效。不要先试长范围列表、超时后再重复提交导出。需要超过100名可用一次 fetchAll 并读取结果，避免为每页重复导出。

## 读取任务结果和导出文件

业务调用返回任务回执，包括 `jobId` 和 `state`。短查询会等待片刻，通常直接返回 `succeeded` 及 `result.data`；较慢的操作返回 `queued` 或 `running`，按 `pollAfterMs` 提示查询：

```js
erp_execute({ operation: 'jobs.status', params: { jobId: '返回的任务编号' } })
erp_execute({ operation: 'jobs.list', params: { limit: 10 } })
```

`succeeded` 才表示执行完成；`failed`、`interrupted` 和 `cancelled` 不能当作成功或空结果。结果以单份 JSON 文本返回，不在 `structuredContent` 中重复整份数据。

`jobs.list` 仅返回任务摘要和文件信息，不重复每个任务的数据；完整结果通过单项 `jobs.status` 获取。

导出使用独立的请求编号。同一次重试复用编号，新的导出使用新编号；相同编号和参数返回原任务，不重复提交。编号与不同参数冲突时会报错：

```js
erp_discover({ operation: 'export_game_products' })
erp_execute({
  operation: 'export_game_products',
  requestId: 'product-export-request-001',
  params: { fields: ['sku', 'name_cn', 'price'], disused: false },
})
```

文件保存在本机，结果返回 `artifact.path`、类型、字节数等信息；不会把 XLSX、CSV、Base64 或整份大型结果塞进上下文。大型 JSON 完整保存到文件并提供有限预览；逐页装箱读取保存为 NDJSON，分页失败会标记不完整并返回失败，不静默截断。

默认导出目录为 `~/Downloads/new-erp`，可用 `NEW_ERP_EXPORT_DIR` 指定专用目录。macOS/Linux 的私有任务目录和文件使用 `0700`、`0600` 权限；Windows 使用当前用户的文件权限。MCP 管理输出路径，不接受调用方的 `output` 参数。任务记录不保存 token 或密码；换账号后不能通过 MCP 读取其他账号的任务。

## 恢复装箱导出与取消任务

装箱导出会在继续轮询前保存 ERP `taskId`。任务中断后先检查原任务；有已保存的装箱检查点时，可使用新的请求编号按原范围恢复：

```js
erp_execute({
  operation: 'jobs.resume',
  requestId: 'packing-resume-request-002',
  params: { jobId: '原装箱任务编号' },
})
```

恢复会校验原查询和 `taskId`，不创建替代导出。没有检查点或其他导出类型不自动恢复、重提；ERP 端任务可能仍继续运行，先查看下载中心。客户端断线不会自动取消已接收的任务；停止执行进程可能中断本地处理。

`jobs.cancel` 可取消本实例中尚在排队的任务。现有业务 API 不支持可靠地取消运行中的 ERP 操作，工具会明确返回不支持。不同 MCP 进程可以共用任务目录；其他存活进程的未完成任务返回最后记录和不确定状态，不自动接管或重试。

## 保留登录会话并更新

会话只保存 ERP 地址、账号、token、用户 ID 和过期时间，不保存密码。默认位置为 macOS/Linux 的 `${XDG_CONFIG_HOME:-~/.config}/new-erp/session.json`，或 Windows 的 `%LOCALAPPDATA%\new-erp\session.json`；也可用 `NEW_ERP_SESSION_FILE` 指定位置。

```sh
npm install -g new-erp-mcp@latest
codex mcp add new-erp -- new-erp-mcp
```

更新后重启客户端以加载新代码。会话文件在包目录之外，有效会话会保留，通常无需重新登录；失效后重新打开登录页。`auth.logout` 删除本机会话，不撤销 ERP 上游 token；已开始的任务继续使用原账号快照，切换账号后不能读取原账号的任务。

## 范围与安全

业务查询按用户授权与明确范围执行。核对 SKU、ASIN、国家、订单编号、仓库、状态、日期和分页完整性；ERP 模糊搜索可能返回前缀或相似项。计划、预测库存与预计可用量不是实际签收凭证。不同批次、BOM 与包装版本应保留原样；重量和尺寸按 ERP 返回单位解释，不作推断。原始响应可能含敏感数据，复用或分享前先脱敏。

本次重构使用本地合成响应和 mock 服务验证，没有进行认证后的生产 ERP 查询。

## 打包验证

```sh
npm ci
npm test
npm run check:package
npm pack
```

`.tgz` 可通过 `npm install -g ./new-erp-mcp-0.6.1.tgz` 安装。发布文件不包含本机会话、项目配置、业务导出或测试数据。使用 `node test/check-package-privacy.js ./new-erp-mcp-0.6.1.tgz` 检查实际归档；检查只报告文件、行号和类别，不输出敏感值。
