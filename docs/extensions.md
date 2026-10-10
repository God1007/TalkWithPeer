# 本机扩展：一期

扩展内容独立维护于 [TalkWithPeer-extensions](https://github.com/God1007/TalkWithPeer-extensions)，平台保存库登记、审查、启停、锁定快照和执行记录。CLI 与 Web 使用同一 SQLite 状态。

## 生命周期

    登记本机路径 → 扫描全部包文件 → 查看当前与上次审查内容
      → 批准当前哈希 → 显式启用 → 锁定本轮版本 → 执行与审计

默认没有启用任何包。批准绑定 version、Git commit 和实际文件内容哈希；Git commit 只记录来源，不会掩盖工作树中的未提交变更。

源文件变化或无法读取会使启用失效。运行阶段只使用锁定清单中的版本，工具和 hooks 执行前重新核对；发现变化时暂停，不自动执行新内容。再次查看文件、审查和启用后才能继续。

运行中的讨论不允许通过 CLI/Web 修改扩展配置。没有热更新、不自动下载、不自动批准第三方内容。

## CLI

    /ext add /绝对路径/TalkWithPeer-extensions
    /ext list
    /ext review <编号或运行ID>
    /ext approve <编号或运行ID> <当前完整哈希> [备注]
    /ext enable <编号或运行ID> <当前完整哈希>
    /ext disable <编号或运行ID>
    /ext call <工具编号或运行ID> {"messageIds":["公共消息ID"]}
    /ext runs

review 显示全部源文件、变更状态和上次审查文本；删除的文件也会列出。call 需要选择会话，执行记录包含会话、调用者、锁定哈希、结果哈希、完成/失败/拦截状态。记录列表显示最近 200 次，数据库保留全部记录。

## Web

**设置 → 管理 Skills / Tools / Hooks**：登记本机目录、刷新、查看文件与差异、审查备注、批准、启停与执行记录。表单批准当前显示的哈希，后端再扫描核对；文件已变则拒绝批准，避免审查与启用之间的内容漂移。

## 运行核心

ExtensionRegistry 负责发现、定义校验、审查锁定与可信操作。每个阶段冻结 skills、tool 清单、hook 标注和锁定哈希，跟随同阶段公开快照进入 ContextManager；内容计入现有预算。

Agent 请求平台工具时返回：

    {"toolCall":{"id":"库ID:包ID","arguments":{"messageIds":["消息ID"]}}}

每个请求最多三次工具调用，结果注入前重新检查容量，并记录生成请求与扩展执行。原文回取和格式修复仍有独立上限；不会因为启用工具就无限循环。

after_reply 在有效回答通过格式与候选校验后、发布前触发。after_compact 在成功保存 checkpoint 后触发。Hooks 不覆盖固定任务、私有 memo、候选或判断。

## 声明式执行边界

一期不运行扩展仓库中的任意脚本。tool 入口只声明 public_read、public_search、project_read，由平台可信处理器执行。project_read 限于所选项目文本，禁止越界、凭证和平台私有目录。public_search 返回明确标记的片段，不冒充完整原文。

Hook 使用 note、audit、deny 的确定性操作。修改用户约束、任意命令、网络请求等定义会被拒绝。包中存在脚本、符号链接或非法声明时，不成为可执行扩展。

原生 Agent 通过平台 JSON 约定调用这些工具；原生运行时内部的其他工具、skills 和 hooks 不被自动同步或接管。直接 API 参与者由平台运行循环执行平台工具。

## 验证

tests/extensions.test.mjs 覆盖独立批准与启用、过期哈希、文件变更、锁定快照、非法包、跨会话读取、项目/凭证边界、hook 拦截、取消、模型工具循环、调用上限，以及终端与 HTTP 共用状态。

后续再考虑任意代码插件的进程隔离、远程分发、依赖安装和更细的预算；这些不是一期已交付能力。
