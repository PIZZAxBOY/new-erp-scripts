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
  "salesData": {
    "enabled": true,
    "maxBytes": 10737418240,
    "minFreeBytes": 1073741824,
    "epoch": ""
  },
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

### 远程销量数据存储与短期缓存

永久销量数据层仅用于远程 HTTP MCP 的 `sales_volume_ranking`；JavaScript API、stdio MCP 和 `source: "list"` 不使用此数据层或共享 TTL 缓存。默认 `salesData.enabled: true`，只保存此排名导出层的已解析完整结果，不代表存储了全部 ERP 数据。数据写入 `dataDir/.sales-data`，以不可变 gzip JSON 快照和校验元数据保存；每个未压缩快照最多 64 MiB。快照不设过期时间、不自动淘汰，也不是备份。容量默认最多 10 GiB，并在写入后仍需至少保留 1 GiB 文件系统可用空间；超限会明确报错，已有快照不会因此删除。超过 32 个缺口时，系统改为重新导出整个请求范围。

`salesData` 可省略，默认值为 `enabled: true`、`maxBytes: 10737418240`、`minFreeBytes: 1073741824`、`epoch: ""`。容量值以字节为单位；`maxBytes` 至少 1024，`minFreeBytes` 为非负整数，`epoch` 最长 200 字符。永久数据没有 TTL；普通查询可复用任意久以前下载的结果。`localData.oldestFetchedAt` 和 `localData.newestFetchedAt` 是 ERP 文件下载时间，不是上游统计快照时间；不同导出可能反映不同的 ERP 状态。不可变指本地快照文件不会自动改写或淘汰；数据层只覆盖销量排名 CSV，不保证不同导出代表一致的上游统计时点。

只有同时匹配已配置的 JY 顶级物料范围、按 SKU 汇总、月度维度、无 SKU/平台/分类筛选且 `sort` 为 `sales` 或 `sku` 的查询，才允许组合时间片段。此范围内，其他排序、年维度及其他账号池范围只复用完全相同的请求快照；零、负值或非整数销量快照也仅允许精确请求复用，不用于片段组合。完整月份数据不能推算部分月份；只有时间范围完全覆盖目标片段的快照可用，保存的精确边缘片段则可与同月其他不重叠片段组合。新快照覆盖重叠时间时会使旧快照的整个重叠片段不再参与组合，但旧版本仍保留。缺失区间按顺序经现有账号池导出；只有覆盖完整且无重叠才合并。组合结果只列出有正销量的 SKU，`mean` 为 `null`，并在 `localData.skuPolicy` 标明 `positive-sales`；不从片段推算均值。

按完整精确查询复用时 `localData.mode` 为 `exact`；组合来源可以是 `assembled` 或 `mixed`，含缺口导出时也可能为 `export`。结果提供 `localData.snapshots`、`oldestFetchedAt`、`newestFetchedAt`；`cache.permanent` 表示命中此永久层。每次请求仍须检查 ERP 会话；账号身份以哈希隔离，且缓存数据不保存访问令牌。权限变化后，管理员必须同时更新 `salesData.epoch` 和 `salesCache.epoch`，使旧权限下的数据不能被复用；本地仍有效的会话无法自动发现 ERP 授权变化。

`forceRefresh: true` 必须配合新的 `requestId`：在重新导出前使目标范围内重叠的本地覆盖失效；旧快照仍在磁盘上，但不会作为该范围的回退结果。即使刷新失败，后续请求也必须重新补齐已失效的覆盖。相同 `requestId` 始终返回原任务，不会重新刷新。

`salesData.enabled: false` 时恢复之前的短期 `salesCache`。该缓存默认启用，TTL 为 900 秒，最大 256 MiB/256 条，最多 1 GiB；支持配置 TTL `1`–`86400` 秒、容量 `1024`–`1073741824` 字节、条目数 `1`–`10000` 及最长 200 字符的 `epoch`。缓存保存在 `dataDir/.sales-cache`，TTL 从完整数据下载、解析和校验完成后计时；上游统计时间可能早于下载时间。设置 `salesCache.enabled: false` 会跳过短期缓存；若 `salesData` 与 `salesCache` 都禁用，则每次都重新导出。长期快照配额不约束 `.mcp-jobs` 任务工件，也不会自动清理这些工件；历史 `.mcp-jobs` 数据不会自动导入，导入前须由管理员核验其覆盖范围。

第一次请求和后续分页使用各自新的 `requestId`；永久数据层会按精确覆盖复用，或对符合条件的月度范围只导出缺口：

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

`salesData` 启用时，返回行包含 `localData` 覆盖信息和 `cache.permanent`；新请求仍可能只导出缺口或使用已有快照。要强制重新导出，使用 `forceRefresh: true` 和新的 `requestId`：

```js
erp_execute({ operation: 'sales_volume_ranking', requestId: 'jy-annual-refresh-001', params: {
  startDate: '2025-01-01', endDate: '2025-12-31', auctionSite: 'JY',
  productTypeCate: '5', forceRefresh: true
} })
```

`salesData.enabled: false` 时，`cache.hit`、`cache.fetchedAt`、`cache.expiresAt` 和未命中时的 `cache.stored` 描述短期缓存；此模式下 `forceRefresh` 会跳过对应缓存并重新导出。永久快照与短期缓存的容量配置都不约束已有或新建的 `.mcp-jobs` 工件。

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
