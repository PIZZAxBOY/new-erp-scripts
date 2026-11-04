# ERP ASIN 查询接口依据

接口行为已从实际 ERP 前端静态资源核对。公开文档省略部署域名、构建文件名和构建哈希；以下仅保留接入所需的接口及字段。业务数据请求需要用户自己的 ERP 登录。

## Listing 搜索

ERP 前端的 `jyAmazon` API 模块声明：

- `GET /sales/ling-xing/jy-amazon-selected-option` 返回搜索枚举。
- `GET /sales/ling-xing/jy-amazon-list-data` 返回 Listing 数据。
- 搜索枚举使用 `other_select_name1_arr`。

`views/sales/listTing/jyAmazon/index.vue` 对应的页面模块使用 `other_select_name1` 选择字段，`other_select_value1` 传搜索内容。请求携带 `page/pageSize`，响应使用 `list/totalCount`。表格的 `sku` 列标为 ERPSKU，另有 `seller_sku`（MSKU）、`fnsku`、`asin` 及 `domain_arr`（店铺信息）。

公共入口模块的 `combinedDataFu` 把原始枚举的键作为选项值，值作为显示标签。实现据此在运行时寻找唯一标签为 `ASIN` 的项，使用其键作为 `other_select_name1`，不猜测编号。

## 商品详情关联

`gameProductList` API 模块声明 `GET /products/game-product-list/index` 和 `GET /products/game-product-list/game-disuse-product-list`。ASIN 搜索返回 ERP SKU 后，先查询在售商品；没有精确匹配时再查询停用商品。两者都使用 SKU 查询参数、完整分页和精确匹配，取得产品基础 ID。

详情继续使用本项目既有 `/products/product-basic/detail?id=...`。Listing 行 ID、ERP SKU 和产品基础 ID 分别保留，不互相代替。

## 商品图片地址依据

商品列表的图片列把 `image_url` 传给共享图片组件。该组件调用图片地址工具函数：从当前 `VITE_GLOB_API_URL` 移除 `/index.php?r=`，再拼接图片路径。因此 `/images/...` 是相对 ERP 地址的图片路径，不能作为可独立使用的 URL 原样返回。API/MCP 使用当前调用的 ERP 地址补全主图 URL，并保留原始 JSON；不硬编码部署域名，也不额外请求图片或附图接口。

## 验证边界

已核对真实前端的路由、字段映射及使用方式，并以本地接口响应验证 JavaScript API/MCP 的完整调用链、分页、账号隔离、模糊匹配过滤和异常处理。已使用登录账号通过 MCP 实测 ASIN 查询，验证停用商品详情及图片获取；公开文档不记录业务标识和结果。实际账号未开放该菜单或搜索枚举时直接报错，不转接领星外部接口或公开亚马逊商品页。

本次 MCP-only 重构沿用上述历史验证证据，并以本地 fixture 和 mock 服务复核调用链；没有新增认证后的 ERP 测试或生产查询。
