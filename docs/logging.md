# 后端与持久化日志

TalkWithPeer 已有本机 Node HTTP 后端：DiscussionEngine 编排讨论，ContextManager 构建输入，ExtensionRegistry 管理已审查扩展；SQLite 是终端与 Web 的同一数据源。扩展仓库只放声明式内容，不运行第二套后台。

默认数据库为 `.talkwithpeer/workspace.sqlite`，设置 `TWP_DATA_DIR` 可改变目录。已有会话、公开消息、memo、checkpoint、模型请求 manifest 与扩展执行审计仍保留。

## 统一运行日志

新增 logs 表按顺序 ID 追加记录，不覆盖历史。包括：

- service：启动、正常关闭、服务错误、重启后恢复未完成讨论。
- http：写请求完成、失败/拒绝与中断，包含方法、规范化路由、状态码、耗时、HTTP 请求 ID 和 CLI/Web 来源标记。
- discussion：运行、暂停、共识等状态变更，以及暂停原因。
- model：请求 pending、returned、tool-request、invalid、complete、failed、interrupted 状态；关联会话、成员、模型、阶段、输入哈希和耗时。
- extension：登记库、批准、启停的追加历史；工具与 hook 状态、锁定版本/内容哈希、执行 ID、模型请求 ID、结果哈希和耗时。

before_tool / after_tool hook 还关联 parentExecutionId。按模型 requestId 查询，可看到该生成请求及其触发的工具；回复审计 hook 关联通过校验的最终请求。HTTP 请求 ID 与模型请求 ID 是不同字段，HTTP 写请求可通过 conversationId 关联后台讨论。CLI/Web 标记只说明入口，当前没有多用户身份认证或分布式追踪。

模型与工具状态落盘时写日志；重启会把 pending 调用标为 interrupted 并追加日志。serviceId 区分不同服务实例。已有旧审计不会伪造为新日志，统一运行日志从本次更新起采集。

## 查看

Web：**设置 → 查看后台日志**。支持分类、级别、当前会话和模型请求 ID 筛选；展开关联详情，按游标查看更早记录。手动刷新。

CLI：

    /logs
    /logs category=model conversation=here
    /logs category=http level=warn limit=20
    /logs request=<模型请求ID>
    /logs before=<上一页nextBefore> limit=50

认证后的 `GET /api/logs` 接受 category、level、conversationId、requestId、before、limit；返回 logs 和 nextBefore，默认 50 条、最多 100 条。筛选在数据库中先执行，再分页，不会因其他会话的近期记录而漏掉旧日志。查询日志本身和成功的轮询 GET 不追加日志，避免自我记录与轮询噪声。HTTP 响应头 X-Request-ID 可定位写请求或失败请求。

## 数据边界

运行日志只收集白名单元数据和经过凭证模式脱敏的错误摘要，不复制 HTTP body、认证头、cookie、URL 查询参数、提示词、工具参数/结果正文或项目材料。完整模型输入与原始工具参数仍属于现有本机私有审计，不会因日志功能变成公开数据。不要把整个数据库上传到 Issues。

日志留在本机 SQLite 中，不自动上传或删除；数据库会随使用增长。一期没有远程日志平台、告警、自动归档或保留期限策略。异常断电未必留下 shutdown 条目，下一次启动会记录“上次退出未确认”，并通过持久化 pending 状态识别未完成调用；这不推断具体崩溃原因。
