# MCP 使用指南

需要 Node.js 20+。服务器在用户本机通过 stdio 运行，不部署远端服务。包只安装一个可执行入口 `new-erp-mcp`，并只注册 `erp_discover` 和 `erp_execute` 两个 MCP 工具。

## 客户端配置

全局安装并注册到 Codex：

```sh
npm install -g new-erp-mcp
codex mcp add new-erp -- new-erp-mcp
```

标准 stdio 配置：

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

也可使用 `npx -y new-erp-mcp`：

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

旧的 `new-erp` 命令行子命令和随包技能已移除。升级后重新注册 MCP 并重启客户端；私有会话位于包目录之外，因此不会因升级而删除。

## 操作

先调用 `erp_discover` 查找能力，传 `operation` 获取精确参数 schema：

```json
{"query":"销量 排名"}
{"operation":"sales_volume_ranking"}
```

随后通过 `erp_execute` 调用：

```json
{"operation":"product_detail","params":{"asin":"B012345678"}}
```

服务发现 24 项业务操作和 7 项辅助操作。辅助能力为 `auth.login`、`auth.status`、`auth.logout`、`jobs.status`、`jobs.list`、`jobs.resume`、`jobs.cancel`。发现操作仅加载选中业务模块的参数，不读取本地配置或会话、不访问 ERP。

首次使用时用 `erp_execute` 调用 `auth.login`。MCP 开启本机临时网页登录；用户亲自在网页中填写 ERP URL、用户名和密码。Agent 不读取或代填秘密信息。成功后只保存受限权限的本地会话 token，不保存密码。页面失效时重新调用 `auth.login`。`auth.logout` 取消待完成登录并删除会话，不会撤销 ERP 上游 token。

MCP 的业务查询绑定当前本机个人会话，不能通过 `NEW_ERP_TOKEN`、共享配置 token 或账号密码绕过会话隔离。会话过期、主机不匹配或被删除时，先重新登录。

## 任务与导出

导出操作异步运行。重复提交时使用同一个稳定 `requestId`；任务完成后可用 `jobs.status` 查询，或用 `jobs.list` 找回最近任务。装箱导出可按原 `taskId` 使用 `jobs.resume` 恢复，但须提供新的 requestId。`jobs.cancel` 只取消排队任务，不能可靠停止已经运行的 ERP 请求。

服务在本机专用目录保存任务状态和导出文件；Unix 权限限制为 `0700`/`0600`。不同账号的任务相互隔离，任务不保存 token 或密码。不要将导出文件、任务目录或原始 ERP 数据提交到版本库或未经授权分享。导出操作可能在 ERP 下载中心创建任务，但不修改业务单据。

## 范围与安全

业务查询按用户授权与明确范围执行。核对 SKU、ASIN、国家、订单编号、仓库、状态、日期和分页完整性；ERP 模糊搜索可能返回前缀或相似项。计划、预测库存与预计可用量不是实际签收凭证。不同批次、BOM 与包装版本应保留原样；重量和尺寸按 ERP 返回单位解释，不作推断。原始响应可能含敏感数据，复用或分享前先脱敏。

没有通过认证的生产查询测试声明；测试使用本地合成响应或 mock 服务。
