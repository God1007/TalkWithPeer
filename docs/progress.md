# 实现进度

## 2026-10-09

- 用户确定一期九项要求，并指定本仓库维护进度。
- 已完成三个原生 Agent 的真实接入验证：Codex / GPT-6.1 Sol、Cursor / Claude Opus 5.5、Reasonix / DeepSeek V4 Pro。
- 已验证共同上下文分发、公开回复、互评提议和只读模式；原生 transport 与 Adapter 基线已迁入。
- 已确认 Codex pet deep link 的参数与本机 sprite v1/v2 资源布局。
- 已实现 SQLite 共同记录、参与者配置、local_session 保存与重启后的中断恢复。
- 已从原生运行时发现实际模型和推理强度选项：Codex 7 个模型、Cursor 模型目录、Reasonix 3 个已配置模型。
- 已实现共识与双向不可让步分歧状态机；缺失、过期或无效判断不会生成终局结果。
- 已使用官方 A2A SDK 验证 Agent Card 发现、v0.3 兼容请求与 contextId 延续。
- 已实现 Codex pet 链接解析、本机导入、sprite 解码验证与帧检测；个人图片不进入 Git。
- 当前 11 项检查通过，覆盖记录恢复、模型参数映射、协议互通和讨论收敛。
- 进行中：正式工作台、会话与项目选择、成员配置、pets 与过程详情、真实 Agent 全流程验证和 HTTP 端点验证。

本文件记录观察到的完成状态，不将计划或模拟结果算作验收通过。

## 2026-10-10

- 正式 React 工作台已完成首版构建，不包含模拟运行路径。
- 已在网页验证会话创建、实际模型与推理强度选择、参数保存、本地项目选择和三个参与者加入。
- 已从本机 Codex 导入真实 Glitchcat 与 JokeBear sprite，个人资源仅保存在本机数据目录。
- 三个原生 Agent 已针对一期共享记忆方案发布真实观点，并明确接受同一候选；平台依据三个有效判断生成共识结果。
- 已按该共识完善完整共同记录与各原生会话的增量同步游标，过大的输入明确暂停，不静默裁剪。
- 当前 13 项检查通过。进行中：同步游标升级后的真实会话复用、分歧终局、暂停恢复、pet 详情和响应式验证。

### 一期收尾

- 已验证三个原生会话在服务重启后复用、再次讨论与候选修订；过程详情、桌面和 390px 窄屏均检查。
- 真实 Codex/Cursor 互相冲突约束曾暴露“认可分歧记录被当作方案共识”的问题。已加入 acceptsSolution 判断，并用真实二轮互评验证分歧终局。
- 已验证网页暂停、继续、项目与配置保存；启动脚本、A2A v1/v0.3 和 pet 解码检查完成。Codex 安装链接解析与下载路径已实现，未使用真实远程安装链接做端到端验证。

### 二期终端与平台上下文

- 根据用户追加要求，把记忆投影从原生增量续接改为平台管理。完整原始记录不迁移或删除，旧原生 session 作为历史追踪数据保留。
- 新增可安装的 twp 命令和 npm run cli；支持 /choose、会话、项目、模型与参数、memo、checkpoint、输出筛选、暂停与继续。所有命令列入 README。
- 终端与网页共用同一服务。已真实验证 npm link 后执行 twp、无网页构建依赖的自动启动与退出，以及管道输入在异步启动后不丢失。
- 新增直接 DeepSeek Chat Completions、OpenAI Responses、Anthropic Messages；模型通过实际接口发现。原生 Codex/Cursor/Reasonix 与 A2A 继续兼容。
- 真实 Codex（GPT-6.1 Sol）、Cursor（Opus 5.5）、直接 DeepSeek（deepseek-flash）在终端完成三方共识。原生每轮会话重新建立，平台 local_session 保持稳定。
- 真实 DeepSeek 生成 checkpoint；服务重启后使用 checkpoint、完整近期记录和 memo 继续得到有效观点与判断。原始 16 条消息仍完整存在。
- 网页可见终端会话和直接 API 参与者，已保存数字输出参数 2048，并用于真实后续调用。
- Reasonix ACP 在终端完成真实独立观点、候选修订及二轮共识，验证其仍能作为兼容通道参与。
- 当前 22 项检查通过，新增 API 三种协议、截断回答拒绝、memo 隔离、checkpoint 来源验证、自动预算压缩、停止后身份保留、终端输出筛选和安装软链接入口检查。
- OpenAI/Anthropic 没有本机 API 密钥，当前为协议测试；A2A 使用协议级服务检查，没有连接用户真实第三方服务。
- 设计参考为 Pi compaction、DeepSeek Harness 与各供应方官方 API 文档。没有引入整套 harness、向量数据库、多用户 ACL 或任意 shell 执行。

### 网页 API 接入补齐

- 用户指出网页只能看到 Agent 接入。后端此前已有直接 API，但网页创建入口只支持 A2A，现已补齐统一连接表单。
- 提供 DeepSeek、OpenAI、Anthropic 预设与自定义 Chat Completions / Responses / Messages；前后端共用预设地址和协议，避免漂移。
- 支持填写 API Key、环境变量或已有 Reasonix DeepSeek 凭证。Key 发现模型成功后才写入本机专用凭证文件，目录 700、文件 600，配置与响应不包含 Key；不使用浏览器持久化存储。尚未接入系统钥匙串。
- 新增 HTTP 检查，覆盖手动 Key 接入、文件权限、重建 registry 后调用、数据库和响应不回显密钥、认证失败和非法 JSON 不泄露凭证。
- 当前 23 项检查通过，前端构建成功；OpenAI/Anthropic 仍为协议验证，不将缺少真实 API Key 的测试标成真实调用。
- 已从网页创建“DeepSeek 直连”，使用已有 Reasonix 凭证发现 deepseek-flash 与 deepseek-v4-pro。该直接 API 与原生 Reasonix 同场发布真实观点和判断，最终达成共识。

### 上下文设计盘点与项目首页

- 核对 ContextManager、讨论引擎、adapter 和 23 项现有检查，明确区分公开记录同步、语义漂移与模型窗口耗尽；本次没有修改运行时行为。
- 新增 context-design.md，记录已有机制、摘要来源校验的局限、统一预算缺少模型输出/推理预留、当前轮次不可压缩、身份元数据与投影审计缺口，并给出 P0–P2 实现与评测顺序。
- 参考 Pi、DeepSeek Harness compaction、Anthropic context editing 与 A2A contextId 官方文档；计划未标为已完成。
- README 改为 Agent 圆桌项目首页，加入原创 SVG 横幅、快速开始、真实验证能力表、结构图、贡献路线图；全部命令与详细配置迁入 docs/usage.md。
- 未将用户导入的个人 pet 素材提交为宣传资产。仓库当前公开但尚无 LICENSE，许可选择等待维护者确定。
- 已核对 31 个文档相对链接及 SVG，23 项现有检查全部通过。
