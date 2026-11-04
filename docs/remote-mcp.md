# 远程 HTTP MCP

`new-erp-mcp-http` 是供个人 SSH 主机运行的远程 MCP 入口，使用 Bun 的 `Bun.serve`，服务只绑定 `127.0.0.1`。公开 HTTPS 应由主机管理员的反向代理提供，并转发到本地监听端口。核心 Fetch handler 可在 Node.js 中以进程内方式测试；没有执行真实 ERP 请求。

## 信任边界与客户端配置

这是单所有者个人服务，不是多租户服务，也不使用 OAuth。客户端只需配置管理员提供的 HTTPS MCP URL 和访问令牌，不需要、也不能通过 MCP 添加 ERP 账号、登录或登出。全部 ERP 会话由主机管理员管理；一个高熵 Bearer 令牌可访问此服务配置的全部 ERP 账号和数据。只把令牌交给获授权的客户端，不要放入查询参数、对话、日志或代码库。

客户端连接 URL 形如管理员提供的 `https://example.com/mcp`（示例域名，请替换为管理员提供的地址），并在每个 MCP 请求中发送：

```http
Authorization: Bearer <由管理员提供的访问令牌>
```

服务拒绝错误的 `Host`、非精确配置的 `Origin`、查询参数令牌、无效 Bearer 令牌和超限请求体；不启用通配 CORS，也不信任 `Forwarded` / `X-Forwarded-*` 头。`GET /healthz` 仅公开 `{ "ok": true }`。HTTP 服务没有 ERP 登录界面或凭据输入字段；会话失效时，MCP 返回联系管理员的提示，管理员在主机上更新 ERP 会话。

## 主机配置

管理员在主机创建仅本人可读的配置和访问令牌文件。通过绝对路径设置 `NEW_ERP_HTTP_CONFIG` 后运行 `new-erp-mcp-http`。配置文件和令牌文件必须是私有权限的普通文件，不得为符号链接；令牌至少 32 个可见 ASCII 字符。配置不包含 ERP 密码或 token。

配置结构如下；所有大写名称和绝对路径都是需要在主机替换的占位符，不是项目内的真实主机或路径：

```json
{
  "publicUrl": "https://example.com/mcp",
  "port": 8443,
  "tokenFile": "/ABSOLUTE/PRIVATE/PATH/mcp-token",
  "dataDir": "/ABSOLUTE/PRIVATE/PATH/mcp-data",
  "sessionFiles": [
    "/ABSOLUTE/PRIVATE/PATH/session-one.json"
  ],
  "maxParallelExports": 3,
  "singleAccountDays": 31,
  "salesCache": {
    "enabled": true,
    "ttlSeconds": 900,
    "maxBytes": 268435456,
    "maxEntries": 256,
    "epoch": "permissions-v1"
  }
}
```

`publicUrl` 必须是 HTTPS origin 加精确 `/mcp` 路径，不可包含用户信息、查询或片段；其 Host 及 Origin 用于严格校验。反向代理必须保留客户端的公开 Host/Origin，不要将 Host 改写为 loopback 地址，也不要依赖转发头完成认证。进程固定绑定回环地址，端口为 `1`–`65535` 的整数。`dataDir` 用于私有任务产物和独占进程锁；若锁仍存在（包括可能的陈旧锁），启动会失败关闭，管理员应先确认旧进程已停止，再人工检查并清理锁。`sessionFiles` 必须包含至少一个不同的绝对路径，不再限制为三个；读取时会验证所有会话文件安全性、身份和有效期。

`maxParallelExports` 是管理员并发上限，范围为整数 `1`–`32`，省略时为 `3`。`singleAccountDays` 是单账号阈值，范围为整数 `1`–`366`，省略时为 `31`；按包含开始时刻到结束秒的实际持续时间判定。两者都只约束本服务提交的账号池导出。

### 可选账号池范围

管理员可按以下结构启用受限的账号池：

```json
"poolScope": { "auctionSite": "JY", "productTypeCate": "5" }
```

配置此范围是管理员的明确断言：所有配置的 ERP 会话已由管理员核实属于同一 HTTPS ERP origin、代表不同身份，并对该范围拥有相同的数据访问权限。**测试夹具或一次性检查不能证明权限长期相同**；权限发生变化时应停用账号池并重新核验。当前账号池仅对已验证的精确查询范围生效；其他查询由一个账号执行。所有分段都成功且校验通过后才会产生完整排名，不返回部分汇总。

只有 `sales_volume_ranking` 的 CSV 模式、按 SKU 汇总、无平台/分类筛选且匹配配置范围的查询才可拆分；按 `mean` 排序或其他不匹配查询始终由一个账号执行。符合条件的查询若不超过 `singleAccountDays`，也只用一个账号。更长范围只考虑日历月边界，并要求首段和末段都至少 14 天；在有效边界中按实际时间长度尽量均分。实际段数不超过账号数、`maxParallelExports` 和有效边界允许的段数，使用 `sessionFiles` 中靠前的账号，不轮转；若没有有效边界则保持单段。各段保留精确的起止时间，互不重叠也不遗漏；提交至少错开三秒。全部 CSV 的文件身份、SKU 唯一性、期间列和小计校验通过后，合并全部 SKU，再统一排序和分页。年度结果由月度数据累加。合并结果的 `mean` 为 `null`，不猜测均值口径；`exportParts` 表示实际合并段数。增加账号不保证等比例提速，ERP 负载和错峰等待都会影响耗时。

### 添加更多服务端账号

管理员使用本地登录流程生成新增账号的独立私有会话文件（权限 `600`），核验同源、不同身份和查询范围的数据权限等价，再将路径追加到 `sessionFiles`，按需要提高 `maxParallelExports`。等待运行和排队任务结束后重启独立 MCP 服务使配置生效，使用 `auth.status` 确认 `accounts` 与 `maxParallelExports`。任一配置账号过期或无效都会要求管理员处理，不静默跳过。远程客户端不需要任何账号设置，也不提供远程添加、登录或登出入口。

### 远程销量缓存

远程 MCP 的 `sales_volume_ranking` 默认启用完整结果缓存；JavaScript API、stdio MCP 和 `source: "list"` 不使用此共享缓存。缓存的是完整、解析并校验过的排名数据，在 SKU 过滤、排序和分页之前读取，因此同一精确查询的不同页和非 `mean` 排序可以复用。不同日期范围不会互相复用，也不从月度缓存拼接任意区间。每次 MCP 请求仍须通过当前 ERP 会话认证；缓存身份部分只使用账号身份哈希，不含访问令牌。

`salesCache` 可省略，默认 `enabled: true`、`ttlSeconds: 900`、`maxBytes: 268435456`（256 MiB）、`maxEntries: 256`、`epoch: ""`。有效范围分别为：TTL `1`–`86400` 秒、总字节数 `1024`–`1073741824`、条目数 `1`–`10000`，`enabled` 必须是布尔值；`epoch` 是不超过 200 字符的管理员版本标记。每条记录另有 64 MiB 上限；超过限制的结果仍可用于本次响应，但不会持久化。缓存存放在 `dataDir/.sales-cache`，使用私有目录/文件权限、SHA-256 校验和、原子写入，并在 TTL 或容量限制触发时优先清除最早写入的记录。禁用缓存会直接调用原导出流程。

缓存键由 schema 版本、精确查询与起止时间、账号身份哈希、账号池范围、并发上限、`singleAccountDays`、是否按 `mean` 排序以及 `epoch` 组成。ERP 会话仍有效并不能证明上游数据权限没有变化；权限或授权范围变化后，管理员必须更新 `epoch`，避免复用旧权限范围的数据。TTL 从完整数据下载、解析和校验完成后计算；默认缓存命中可能返回最多 15 分钟前的数据，不是实时查询或不可变历史快照。旧的 `.mcp-jobs` 任务结果不受 `salesCache` 的字节数/条目数限制，也不会自动清理。

第一次请求和后续分页使用各自新的 `requestId`；相同请求、不同页可以命中同一完整缓存：

```js
erp_execute({ operation: 'sales_volume_ranking', requestId: 'jy-annual-page-1', params: {
  startDate: '2025-01-01', endDate: '2025-12-31', auctionSite: 'JY',
  productTypeCate: '5', page: 1, pageSize: 10
} })

erp_execute({ operation: 'sales_volume_ranking', requestId: 'jy-annual-page-2', params: {
  startDate: '2025-01-01', endDate: '2025-12-31', auctionSite: 'JY',
  productTypeCate: '5', page: 2, pageSize: 10
} })
```

返回行会标记 `cache.hit`、`cache.fetchedAt` 和 `cache.expiresAt`；未命中时还含 `cache.stored`。要强制重新导出，使用 `forceRefresh: true` 和新的 `requestId`：

```js
erp_execute({ operation: 'sales_volume_ranking', requestId: 'jy-annual-refresh-001', params: {
  startDate: '2025-01-01', endDate: '2025-12-31', auctionSite: 'JY',
  productTypeCate: '5', forceRefresh: true
} })
```

强制刷新会先删除该精确查询的旧缓存；如果新导出失败，不回退到旧结果。复用原 `requestId` 始终返回原任务，不会触发刷新。权限变化应更新 `epoch`；`forceRefresh` 适合获取较新的上游数据。缓存容量配置只约束 `.sales-cache`，不约束已有或新建的 `.mcp-jobs` 工件。

## 请求限制与任务结果

默认限制为请求体 128 KiB、最多 32 个并发请求、全局突发 120 个请求并以每秒 2 个请求补充；下载文件上限为 64 MiB。响应使用禁止缓存和 `nosniff` 标头。

MCP 结果和 `jobs.list` 不返回主机文件系统路径；完整且成功的产物提供 `downloadUrl`。客户端必须携带同一个 Bearer 令牌访问 `/artifacts/<job-id>`。服务会检查任务所属会话、成功状态、产物完整性、固定文件名、目录包含关系、符号链接和私有文件权限；调用方不能指定文件路径。支持的附件为 `result.json`、`pages.ndjson`、`export.csv` 和 `export.xlsx`。

客户端断开不会关闭共享任务运行时，已接受的任务可在同一服务进程中继续。主机服务进程重启会中断本地运行任务；不会自动或透明恢复。客户端应检查任务状态；仅在明确支持时由管理员或授权客户端显式恢复。过期 ERP 会话、权限变更和账号池配置由管理员处理。

## 安全与运行边界

- 仅在已配置 HTTPS 反向代理保护下公开服务；不要在公网直接提供明文 HTTP。
- 一个 Bearer 令牌授权所有配置账号的能力，不能用于隔离不同用户或租户。
- 不要向 MCP 客户端提供 ERP 用户名、密码或上游 token 输入；会话在主机上由管理员管理。
- 查询只读 ERP 业务数据；导出仍可能在 ERP 下载中心创建导出任务。
- 远程服务器与 stdio 服务器使用相同的业务工具；远程模式隐藏并拒绝 `auth.login` 和 `auth.logout`。
