# 架构决定

终端与 React 网页调用同一个本机 HTTP 服务；SQLite 保存完整消息、成员配置、候选、判断、事件、memo 和 checkpoint。终端连接已运行服务，不打开第二个 Store，不对正在讨论的会话执行重启恢复。

## 接入

适配层统一能力发现、执行一轮、公开事件、取消与释放。Codex app-server、Cursor headless、Reasonix ACP、标准 A2A 为原生兼容通道；OpenAI Responses、Anthropic Messages、DeepSeek/兼容 Chat Completions 为直接模型通道，直接调用不传供应方会话续接参数。

## 上下文

一期复用原生会话并按游标同步。二期按用户要求替换策略：平台每次重建上下文，每位成员稳定的 local_session 是平台身份；remoteSession 是单轮追踪标识。原生兼容通道每个请求结束后关闭，下轮不续接隐藏历史。

ContextManager 是记录到输入的唯一投影入口。输入包含共享 memo、当前成员 memo、checkpoint 及其边界后的完整消息。同一阶段各成员使用相同公开版本；私有 memo 按成员隔离。终端筛选仅改变显示，不影响输入。

预算按 UTF-8 字节估算，检查实际拼接后的请求。超过预算可压缩早期用户轮次，最新用户轮次及其观点、判断不裁剪。新 checkpoint 保存源消息 ID、边界、前一 checkpoint ID 和生成模型；原始日志完整保留。失败、取消、来源无效或压缩未减小容量时，不替换已有 checkpoint。

memo 当前由用户管理，没有模型自行无限写入的长期记忆或向量库。成员 memo 是上下文隔离，不是多用户 ACL。模型摘要可追溯，但语义正确性需要核对。

借鉴 [Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md) 的追加 checkpoint 与上下文重建，参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的显式组件边界，未引入完整框架。

## 项目材料

原生兼容通道保留只读项目执行。直接 API 无本机文件访问；用户通过 /read 将具体文件保存为带路径的共享 memo。realpath 验证拒绝项目外路径、常见凭证、二进制和过大文本。不增加任意 shell 执行。

## 收敛

独立观点后判断同一编号候选。所有当前成员必须 stance=accept、acceptsSolution=true，且没有不可让步冲突，才报告共识。认可分歧记录不是接受解决方案。

分歧终局需两轮交流后两位成员保留双向明确不可让步立场。错误、取消、缺失或过期判断及轮数上限只暂停。修改候选获得新 ID，旧判断不可复用。

## 可见性与边界

网页和终端展示公开回答、解释、工具活动及供应方公开推理摘要，不复制或伪造未公开内部思维。API 原始错误体不转发，凭证不进入平台数据。

本机单用户服务绑定回环地址，校验 Host、Origin、cookie 和写请求。仅健康检查及受来源和请求格式限制的 session 握手不要求已有 cookie。无 ACL、自定义职责或原生工具公共远程部署。
