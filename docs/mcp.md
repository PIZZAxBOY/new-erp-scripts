# 通过 npm 安装本地 MCP

本包提供本地 stdio MCP，不需要部署在线服务。每位用户在自己的电脑上安装并登录 ERP，电脑需能访问 ERP。需要 Node.js 20+；自动接入 Codex 还需要 Codex CLI。

## 安装与登录

从 npm 安装：

```sh
npm install -g new-erp-mcp
```

也可以下载打包生成的 `.tgz`，通过 npm 安装：

```sh
npm install -g ./new-erp-mcp-0.2.1.tgz
```

在自己的终端完成登录，ERP 地址替换为实际地址：

```sh
new-erp login --baseUrl https://your-erp.example.com
new-erp setup --client codex
```

`login` 提示输入账号和密码，密码不回显。也可用 `--username` 提供账号。非交互环境使用 `NEW_ERP_USERNAME` 和 `NEW_ERP_PASSWORD`；不要把密码放进命令参数或聊天。登录失败不会覆盖原会话。

重启 Codex 后即可使用，例如“查询某个 SKU 的产品图片”。`codex mcp list` 可查看注册配置；Codex 终端界面中的 `/mcp` 可查看连接状态。所有工具都要求有效的本机 ERP 会话。

## Codex 配置

`setup` 调用 `codex mcp add`，注册当前安装的 Node.js 和 `scripts/mcp.js` 的绝对路径，不将账号、密码或 token 写入 Codex 配置。它会替换同名配置，其他名称的 MCP 不受影响。

```sh
new-erp setup --client codex --dryRun
new-erp setup --client codex --name my-erp
```

其他支持本地 stdio 的客户端可以使用 `new-erp mcp` 作为启动命令，也可使用 Node.js 和 MCP 脚本的绝对路径。先独立完成登录，MCP 进程的标准输入与输出只传输协议，不能用于交互输入密码。

不要通过临时的 `npx` 安装目录运行 `setup`；全局安装能提供持久的脚本路径。移动包目录、切换 Node.js 安装位置或更新包后重新运行 `setup`。Codex 的接入方式见 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)。

## 更新版本

```sh
npm install -g new-erp-mcp@latest
new-erp setup --client codex
```

更新后重启 MCP 客户端以加载新代码。本机登录会话保存在包目录之外，更新包不会删除会话；同一系统用户、ERP 地址和会话路径下，有效 token 可继续使用，无需重新登录。token 失效、主动退出或更换上述配置后，重新运行 `new-erp login`。

## 可用工具

| MCP 工具 | 用途 |
| --- | --- |
| `game_product_list` | 按 SKU、品名、分类和类型查询 ERP 商品及图片，每次返回一页。 |
| `product_detail` | 按 ERP 产品基础 ID 或 ASIN 查询详情、ERP 图片和全部 SKU/BOM 版本；`id/asin` 二选一。ASIN 先查 ERP Listing，再按匹配的 SKU 获取详情。 |
| `inventory_list` | 按精确 SKU、仓库代码查询库存批次或仓库汇总，每次返回一页。 |
| `erp_options` | 查询库存、装箱或配货仓库的实时枚举。 |

工具直接调用已有 JavaScript 函数。数组结果封装为 `{ list }`，对象结果保持原结构；同时返回 MCP 文本和 `structuredContent`。工具参数不接受账号、密码、token 或自定义 ERP 地址。

商品列表和库存支持 `page`、`pageSize`，默认第1页20条，每页最多100条。`product_detail` 的 ASIN 解析会完整读取相关 Listing 和 SKU 搜索，每页100条，`maxPages` 默认100、上限1000，保留全部精确匹配及店铺信息。批量导出和其他全量查询可继续使用 CLI/API。库存预测量不是已签收库存，保留批次与 BOM 差异。

## 本机登录会话

会话仅包含 ERP 地址、账号、token、用户 ID 和上游返回的过期时间，不保存密码，也不会上传到额外的服务。位置为：

- macOS/Linux：`${XDG_CONFIG_HOME:-~/.config}/new-erp/session.json`。
- Windows：`%LOCALAPPDATA%\new-erp\session.json`，缺少该变量时使用用户目录下的 `AppData\Local`。
- 设置 `NEW_ERP_SESSION_FILE` 可指定其他位置，适合隔离不同本地环境。

token 以明文保存在本机文件，macOS/Linux 文件权限为 `0600`，应用新建的目录为 `0700`；Windows 使用当前用户目录的文件权限。不要分享或提交会话文件。登录写入采用临时文件后原子替换，读到的会话对应一次完整登录。

MCP 每次 ERP 调用读取当前会话，并把 ERP 地址及 token 绑定到该次调用；不回退到当前目录的 `config.json` 或 `NEW_ERP_TOKEN`。切换账号或退出后，后续调用使用新的状态，已开始的调用继续使用开始时的会话。

可识别的过期时间到期，或 ERP 返回登录失效时，需要重新运行 `new-erp login`。目前没有自动刷新 ERP token 的实现。权限不足保留为权限错误，不换用其他账号。

```sh
new-erp logout
```

`logout` 删除本机保存的会话，不撤销上游 token，也不修改项目配置或环境变量。旧 CLI/API 显式配置的认证仍按原方式生效；MCP 的 ERP 工具要求重新登录。

## 打包与验证

```sh
npm ci
npm test
npm run check:package
npm pack
```

`npm pack` 生成可供 npm 安装的 `.tgz`。可作为 Release 附件分发；上传 Release 或发布 npm registry 是单独的发布操作。包中不包含本机会话、项目配置或测试数据。

`npm run check:package` 检查实际发布文件清单，阻止内部服务地址、个人路径、凭据和业务导出文件进入包。检查已生成的包可用 `node test/check-package-privacy.js ./new-erp-mcp-0.2.1.tgz`；检查结果只输出文件、行号和类别，不输出匹配到的敏感值。
