# 安装与使用本地 MCP

需要 Node.js 20+。MCP 在用户自己的电脑运行，使用各自的 ERP 登录和权限，无需部署服务器。MCP 用户无需安装仓库的可选 CLI 技能。

## 安装并接入客户端

```sh
npm install -g new-erp-mcp
new-erp setup --client codex
```

重启 Codex 或 T3 Code 以加载 MCP。`setup` 需要已安装的 Codex CLI，将当前 Node.js 和 MCP 脚本的绝对路径写入客户端配置，不写入账号或凭据。用 `codex mcp get new-erp` 检查路径；`new-erp setup --dryRun` 预览注册命令。不要用临时 `npx` 安装目录运行 `setup`。

其他支持本地 stdio 的客户端可将 `new-erp mcp` 配置为启动命令。标准输入和输出仅传输 MCP 协议。

## 首次在网页完成配置

向 Agent 提出业务需求即可，例如“按 ASIN 查询商品图片”。未登录时，工具返回配置引导，Agent 调用：

```js
erp_execute({ operation: 'auth.login', params: {} })
```

该调用立即返回本机登录链接，并自动尝试打开浏览器。用户在页面一次填写 ERP 网址、账号和密码；不能自动打开时手动打开返回的链接。Agent 不查看或填写真实密码字段。密码由网页直接交给本地程序登录 ERP，不进入对话、工具参数、命令参数或结果，也不会保存。

页面五分钟后失效，成功、取消或过期后关闭临时服务。登录失败可在原页面重试，不会覆盖原会话。Agent 可查询 `auth.status`，登录成功后重试原业务操作，无需重启 MCP。

也可独立运行 CLI：

```sh
new-erp login --browser
new-erp login --browser --open false
```

第二条只输出登录链接。网页不可用时，使用客户端私密输入能力或在自己的终端运行 `new-erp login --baseUrl https://your-erp.example.com`，隐藏输入密码。不要在聊天正文或命令参数中提交密码。

## 按需发现能力和参数

初始化只加载两个工具，完整业务参数在需要时返回：

| 工具 | 用法 |
| --- | --- |
| `erp_discover` | `query` 按关键词找能力；`operation` 返回所选能力的参数；都省略时列出目录。 |
| `erp_execute` | 用 `operation`、`params` 执行；导出还需稳定的 `requestId`。 |

目录覆盖现有 24 项业务能力：商品与分类、ASIN 图片、销量与汇总、市场订单、库存与凭证、装箱与配货、外包装、物流与申报，以及全部导出。`auth.*` 和 `jobs.*` 也通过同一个入口按需调用。

```js
erp_discover({ query: '商品' })
erp_discover({ operation: 'product_detail' })
erp_execute({ operation: 'product_detail', params: { asin: 'B012345678' } })
```

ASIN 是示例值。其他业务参数以对应的 `erp_discover({ operation })` 结果为准；未知参数、错误类型和凭据参数会被拒绝。查询只使用本机保存的个人会话，不回退到环境或项目中的共享 token。

0.3 起，原四个直接 MCP 工具改为业务能力名称。例如原 `product_detail({ asin })` 改为上面的 `erp_execute` 调用。CLI 和 JavaScript API 保留原有入口。

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

默认导出目录为 `~/Downloads/new-erp`，可用 `NEW_ERP_EXPORT_DIR` 指定专用目录。macOS/Linux 的私有任务目录和文件使用 `0700`、`0600` 权限；Windows 使用当前用户的文件权限。MCP 管理输出路径，不接受 CLI 的 `output` 参数。任务记录不保存 token 或密码；换账号后不能通过 MCP 读取其他账号的任务。

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
new-erp setup --client codex
```

更新后重启客户端以加载新代码。会话文件在包目录之外，有效会话会保留，通常无需重新登录；失效后重新打开登录页。`auth.logout` 或 `new-erp logout` 删除本机会话，不撤销 ERP 上游 token；已开始的任务继续使用原账号快照，切换账号后不能读取原账号的任务。

## 打包验证

```sh
npm ci
npm test
npm run check:package
npm pack
```

`.tgz` 可通过 `npm install -g ./new-erp-mcp-0.3.0.tgz` 安装。发布文件不包含本机会话、项目配置、业务导出或测试数据。使用 `node test/check-package-privacy.js ./new-erp-mcp-0.3.0.tgz` 检查实际归档；检查只报告文件、行号和类别，不输出敏感值。
