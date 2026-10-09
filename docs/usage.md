# 使用手册

网页和终端共用会话与上下文。本文保留全部命令、API 接入、项目和凭证说明。

## 启动

需要 Node.js 22.13+。在仓库目录执行：

    npm install
    npm run cli

无需构建网页即可使用终端。安装命令后，可在任意目录启动：

    npm link
    twp

终端先连接已有本机服务；没有服务时自动启动。退出自动启动的终端会停止它拥有的服务；连接已有网页服务时，退出只断开终端。

网页入口：

    npm run build
    npm start

打开 [本机工作台](http://127.0.0.1:48273/)。也可以双击 macOS 的 TalkWithPeer.command。网页和终端可以同时打开，使用同一个会话。

## 第一次讨论

安装并登录 Codex、cursor-agent 或 Reasonix 后，在终端输入：

    /choose codex,cursor
    /agents
    /models 1
    /model 1 <模型ID>
    /param 1 effort low
    /project /绝对路径/项目
    /memo add 原始消息保留，压缩不得抹掉分歧
    讨论这个项目的架构。

/choose 不带参数时列出连接，可以直接输入编号，例如 1,2。连接编号来自 /choose；参与者编号来自 /agents；会话编号来自 /sessions；memo 编号来自 /memo list。

每段输出标明来源，例如：

    [Codex · gpt-6.1-sol · 轮次 0]
    独立观点……

    [DeepSeek API · deepseek-flash · 轮次 1]
    对候选的判断……

实时默认显示公开消息和结果。/show trace 展示公开活动，/focus 2 只看第二位 Agent 的实时发言，/hide messages 隐藏后续正文，/history 随时重读完整记录。这些筛选不会删除消息，也不改变 Agent 收到的上下文。

## 直接模型 API

网页中打开 **设置 → 添加 API / Agent 连接 → 模型 API**，选择 DeepSeek、OpenAI、Anthropic 或自定义兼容 API。填写连接名称、基础地址及认证方式，连接后在“添加参与者”中选择该连接和模型。API 与原生 Agent 可以参加同一场讨论。

认证方式支持填写 API Key、使用服务进程的环境变量，以及复用本机 Reasonix 的官方 DeepSeek 凭证。填写的 Key 在发现模型成功后保存到本机 runtime/credentials/，目录权限 700、文件权限 600；它是本机明文文件，未接入系统钥匙串。连接配置只保存凭证来源，不保存或返回 Key；表单成功后清空 Key。不使用浏览器 localStorage 保存凭证。

直接 API 使用平台构建的完整上下文，不依赖供应方的会话续接或原生 harness。模型来自实际 /models 接口；输出上限可通过 /param 1 outputTokens 4096 设置。

在启动服务的环境中设置相应密钥，再连接：

    /connect deepseek
    /connect openai
    /connect anthropic
    /choose

环境变量分别为 DEEPSEEK_API_KEY、OPENAI_API_KEY、ANTHROPIC_API_KEY。密钥值不写入数据库、连接响应或仓库。网页手动输入的 Key 只提交给本机服务，并由服务发送到所配置的 API 地址。模型由账户实际能力决定，不硬编码某个模型可用。

已有 Reasonix 的本机 DeepSeek 凭证时，可明确选择复用：

    /connect deepseek --from-reasonix

该选项只读取 ~/.reasonix/.env 中的 DEEPSEEK_API_KEY，只发送到官方 https://api.deepseek.com，不复制密钥。首次连接会调用模型发现接口；讨论和压缩会产生模型调用费用。

其他兼容 API：

    /connect api chat MyProvider https://example.com/v1 MY_API_KEY
    /connect api responses MyOpenAI https://example.com/v1 MY_OPENAI_KEY
    /connect api messages MyClaude https://example.com/v1 MY_CLAUDE_KEY

连接名称不可含空格。基础地址包含 API 前缀，程序追加 /models 和协议对应的请求路径。远程地址需要 HTTPS，本机可用 HTTP。

标准 A2A：

    /connect a2a https://example.com/.well-known/agent-card.json TOKEN_ENV

A2A 使用官方 SDK，支持 v1 和 v0.3 兼容协议。Agent Card 的服务接口必须与发现地址同源。

## Slash commands

| 命令                                   | 用途                                                      |
| -------------------------------------- | --------------------------------------------------------- |
| `/help`                                | 查看命令                                                  |
| `/choose [连接编号或ID,...]`           | 列出并添加 Agent，无参数支持输入编号选择                  |
| `/agents`                              | 当前参与者、模型和参数                                    |
| `/remove <参与者编号>`                 | 移除参与者，历史消息保留                                  |
| `/models <参与者编号>`                 | 查看实际模型和参数能力                                    |
| `/model <编号> <模型ID>`               | 切换模型，重置旧模型参数                                  |
| `/param <编号> <参数> <值>`            | 调整推理强度或输出上限                                    |
| `/connect <类型> ...`                  | 添加 API 或 A2A 连接                                      |
| `/new [名称]`                          | 新会话                                                    |
| `/sessions`                            | 列出会话                                                  |
| `/use <会话编号或ID>`                  | 切换会话                                                  |
| `/rename <名称>`                       | 重命名                                                    |
| `/project [路径或off]`                 | 选择、查看或解除本地项目                                  |
| `/read <项目内相对文件路径>`           | 文本文件加入共享 memo，拒绝越界路径、常见凭证文件和二进制 |
| `/memo [list]`                         | 查看 memo 和来源                                          |
| `/memo add <内容>`                     | 添加共享 memo                                             |
| `/memo agent <编号> <内容>`            | 添加仅注入该成员上下文的 memo                             |
| `/memo remove <memo编号或ID>`          | 删除 memo                                                 |
| `/context`                             | 查看预算、压缩和当前上下文状态                            |
| `/context full`                        | 查看重建后的共享上下文；/focus 后包含该成员 memo          |
| `/context budget <数量>`               | 配置 4000–128000 的估算 token 预算                        |
| `/context auto <on或off>`              | 自动压缩开关                                              |
| `/compact [参与者编号]`                | 选定模型压缩早期轮次，默认第一位参与者                    |
| `/show <messages或trace或result或all>` | 开启对应实时内容                                          |
| `/hide <messages或trace或result或all>` | 隐藏对应实时内容                                          |
| `/focus <参与者编号或all>`             | 筛选 Agent 的实时输出                                     |
| `/history [参与者编号]`                | 重读完整公共消息                                          |
| `/trace [参与者编号]`                  | 重读公开进度、解释和工具活动                              |
| `/result`                              | 当前结果或暂停原因                                        |
| `/rounds <1–8>`                        | 设置本次判断轮数                                          |
| `/resume`                              | 继续当前问题                                              |
| `/stop`                                | 暂停当前讨论                                              |
| `/wait`                                | 等待当前讨论结束                                          |
| `/exit`                                | 退出终端                                                  |

Ctrl+C 在讨论中请求暂停，空闲时退出。输入可通过管道传入；EOF 会等待当前讨论，不丢弃输出。/exit 在连接已有服务时让讨论继续；在终端自建服务时先暂停再关闭。

## 平台记忆与上下文

原始公开记录、共享 memo、成员 memo、checkpoint 分开保存。每位参与者拥有稳定的 platform local_session；原生或远程会话另记为 remoteSession。模型公开回答可以共享，成员 memo 只注入对应成员；未公开的内部思维不复制、不伪造。

每个请求由平台构建：共同身份和版本、用户约束、checkpoint、近期完整消息、共享 memo、成员 memo，以及当前候选和公开判断。直接 API 不发送 previous_response_id 或远程 conversation；原生兼容模式每轮建立新的运行时会话，避免依赖原生隐藏的长期压缩。原生工具循环和单轮内部压缩仍由其运行时负责，因此不能保证不同供应方内部执行完全一致。

预算按 UTF-8 字节启发式估算，不宣称是精确 tokenizer 计数。接近预算时可自动压缩早期轮次，始终保留最新用户轮次及其完整观点、判断。checkpoint 保留原始来源 ID、边界、前一 checkpoint 和生成模型；原消息不删除。失败、取消、无效来源或压缩没有减少容量时不保存 checkpoint。单个当前轮次过大则暂停，用户可提高预算或开新会话。

摘要由模型生成，来源校验并不保证语义无误；可用 /context full 与 /history 核对。明确约束适合放入 memo，以免仅依赖摘要保留。memo 目前由用户管理，未实现 Agent 自行持久化私有记忆。

API 参与者只看平台发送的内容。项目路径本身不会授予远程模型本机文件访问；使用 /read 明确分享文件。原生参与者可以按其只读运行模式分析所选项目。

## 讨论结果

每个候选有独立 ID。所有当前参与者都必须明确接受同一候选作为原问题的解决方案，才报告共识。认可“记录分歧”不等于接受解决方案。

分歧终局需要两位成员在交流后再次明确保留互相冲突的不可让步立场。错误、超时、停止、无效判断或轮数上限都只暂停，不制造结果。继续讨论会重新收集观点和判断。

## 网页与 pets

网页支持会话选择、项目浏览、真实模型和参数选择。每位成员在右下角有一个 pet，点击可看 local_session、公开回复和过程。支持导入本机 Codex pets 与 codex://pets/install 链接；个人图片只保存在本机，不进入 Git。

网页和终端均可添加 API 连接；连接与参与者可在两种界面选择、配置和继续。网页支持枚举参数与数字输出预算。

## 数据和边界

数据默认保存在仓库 .talkwithpeer/，已忽略。TWP_DATA_DIR 改变数据目录，TWP_PORT 改变端口；终端和网页应使用同一组设置。SQLite、导入图片和运行目录在其中。

本机单用户服务绑定回环地址，校验 Host、Origin、cookie、写请求格式和输入。没有多用户 ACL 或自定义职责。原生账户认证保留在各自工具中。

## 检查与设计参考

    npm test
    npm run build

检查覆盖持久化、中断恢复、候选判断、A2A 两种版本、模型参数、sprite、HTTP 边界、终端选择和过滤、API wire format、成员 memo 隔离和 checkpoint 原记录保留。

- [Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)：采用追加 checkpoint、保留源记录、重建摘要与近期上下文的设计。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：参考显式 runtime 边界；没有引入整套框架依赖。
- [OpenAI Responses](https://developers.openai.com/api/docs/guides/text)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)：直接协议接入依据。
- 接口见 [agent-interface.md](agent-interface.md)，架构见 [architecture.md](architecture.md)，实际验证见 [progress.md](progress.md)。
