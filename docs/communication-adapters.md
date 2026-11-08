# 公共通信模块与 Adapter 接入

公共模块静态注册 Telegram HTTPS 长轮询和 QQ WebSocket 单聊 Adapter。桌面「通信渠道」设置提供添加、测试、启动、停止、加密凭据轮换、两步账号绑定和逻辑删除。验证使用替身平台传输、临时 SQLite、真实 Python JSONL 和可控模型。真实平台、Electron E2E 和跨 OS 验收待开展。

## 代码边界

- `src/core/communication/` 定义标准消息、能力、绑定、确认票据、Inbox、调度、会话、Outbox 及可注入的时钟、随机源、摘要、定时器和安全诊断。业务只通过 `BusinessPort` 调用。
- `src/main/communication/` 静态装配 Adapter、Main 专用凭据库和 `ConversationBusinessPort`；管理接口统一经过可信 IPC 守卫。Renderer 仅使用 `window.api.communication`，不能回读凭据、正文、内部 session、游标或账本。
- `src/database/communication-migration.ts` 是 v15 增量迁移，不重写原业务表。各表 JSON 记录的生成列提供外键、事件唯一键、活动绑定和活动上下文约束。仓储采用同步 `IMMEDIATE` 事务及差量 UPSERT，禁止异步事务回调。
- 桌面使用 Electron 单实例锁。Inbox 原子认领还检查持久化执行状态和 scope，防止重复消费。同 session 串行，最多两个不同通信 scope 同时进入业务；既有 ConversationExecutions、领域锁及 Python 全局预算继续生效。

## 已开放业务及恢复证据

| 操作                                   | 分派                                                             | 完成关联 / 恢复方式                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 普通文本                               | ConversationModule → 既有 Python conversation / concept 策略     | 调用前持久化 requestId、sessionId 和 canonical user / assistant messageId；仅按两个精确 ID 读取已保存消息。                  |
| `/sentence <原文>`                     | ConversationModule.runSkill → SentenceConversationSkill → Python | 先按 sessionId / userMessageId 读取 sentence 执行，再核对 report.requestId；仅从已提交报告生成本地反馈。                     |
| `/new`、`/help`、`/cancel [requestId]` | 通信控制层                                                       | 不调用模型。new 按队列顺序结束映射，忙碌时拒绝；cancel 走独立优先入口并校验绑定及 scope。                                    |
| `/confirm <票据>` / interaction token  | 同一票据验证器                                                   | 校验 binding / principal / session / 原始事件 / 操作 / 参数摘要 / 到期和消费状态；仅记录消费，不自行推断或执行新的学习操作。 |

其他显式技能（含 vocabulary、phrase、synonym、tts、两类 explore）均未进入远程白名单。多阶段或逐词提交、文件恢复、音频能力及结果投影需要各自完成审计后扩展，不得把“最后一条 assistant”当作提交证明。新增自然语言确认策略仍须进入 Python。

每次接收冻结 UI、讲解和目标学习语言；目标语言准入复用项目支持列表。执行通过可信 context 传入语言和 canonical 消息 ID，不切换全局 resolver。渠道会话通过 ConversationModule 先创建持久化会话，再建立带外键的映射。这个顺序在崩溃时最多留下空业务会话，不会留下悬空映射；未知执行保守保留 interrupted。桌面 IPC 仍使用原窗口归属，窗口销毁不取消渠道请求。

## 固定预算与状态

唯一默认值在 `communication-contract.ts` 的 `LIMITS`：

| 项目                              | 默认值                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| 外部 ID / 文本 / 游标             | 256 / 4,000 / 8,192 UTF-16 单元                                                                   |
| 单 scope 普通队列 / 全局积压      | 8 / 256                                                                                           |
| 单 scope 控制队列 / 全局控制队列  | 4 / 32；cancel 不排队，仍计控制速率                                                               |
| 账号 / 连接普通速率；账号控制速率 | 20 / 120 条每 60 秒；20 次每 60 秒                                                                |
| 入站有效期 / 未来时钟容差         | 5 分钟 / 30 秒                                                                                    |
| 绑定挑战 / 尝试                   | 5 分钟 / 5 次；128 bit 随机码，数据库只存摘要                                                     |
| 确认票据 / session 空闲           | 2 分钟 / 24 小时                                                                                  |
| 业务协调期限 / 连接与单次发送期限 | 180 秒 / 30 秒                                                                                    |
| 出站有效期 / 重试                 | 从原始接收起 24 小时 / 每片段 5 次；指数退避 1–60 秒，并尊重平台等待时间                          |
| 正文 / 去重墓碑                   | 7 / 30 天；过旧事件即使墓碑清除也被有效期拒绝                                                     |
| 快照容量 / 连接上限               | Inbox 含墓碑最多 10,000 条 / 32 条连接；容量耗尽返回接收失败 BACKPRESSURE，不确认传输、不删除墓碑 |
| 有界停止                          | 3 秒                                                                                              |

请求：received → queued → dispatching → running → succeeded / failed / cancelled；拒绝、过期、interrupted 独立记录。跨越 dispatching 后不自动重放。启动恢复只读核对精确关联，能证明已提交才补登记结果和 Outbox；未知结果保持 interrupted 并提示桌面核对。

投递：pending → sending → sent / retry_wait / failed / uncertain / suppressed。只有确定未发送的临时错误可自动重试。超时、异常、非法发送回执和重启时的 sending 均为 uncertain，桌面明确勾选可能重复后才能重试。重试使用同一片段、partId 和编码版本，已确认的片段不重发；编码版本变化时保留待处理状态。解绑、逻辑删除连接或过期阻止未发内容；已发记录保留事实。停止连接保留队列和待发结果，下次显式启动恢复。Telegram 显式启动会持久化 `autoStart` 标记，应用重启并完成初始化后异步恢复这些连接。启动失败时卡片显示错误，可重试的故障继续按原退避规则重连。渠道停止运行但仍保留启动意愿时，卡片提供「关闭自动启动」。停止、关闭自动启动和轮换凭据均清除该标记。

业务调度与投递使用独立的单次运行协调：业务仍在运行时，后续 250 ms tick 可继续重连和投递已保存的回复；重叠 tick 复用同一次投递，避免重复发送。手动启动与自动重连均先中止旧代次并等待旧 Adapter 停止；清理失败或超过 3 秒时保留旧实例并进入 error，不创建替代实例。清理期间显式停止或退出会阻止后续启动。

离线队列也由定期清理检查消息有效期，过期后标记 expired，不再执行业务，并保留原接收回执用于去重。其正文和去重记录同样按 7 天／30 天清理，不依赖连接重新上线。

错误码包含 UNBOUND、CHALLENGE_INVALID、CONFIRMATION_INVALID、OWNER_MISMATCH、CAPABILITY_DENIED、UNSUPPORTED_SCOPE、UNSUPPORTED_INPUT、EXPIRED、RATE_LIMITED、QUEUE_FULL、EVENT_CONFLICT、BACKPRESSURE、STOPPED 和 STORAGE_FAILED。`rejected` 是已持久化拒绝，`failed` 表示接收未完成。无法可靠映射 actor/chat 的更新使用 Main 专用 `receiveRejected`，仅持久化事件 ID、分类与摘要，不创建虚构账号、会话或 Outbox；与标准事件共享唯一键和 10,000 条容量。重复回执及冲突摘要（有界保存）与游标同事务提交，墓碑按 30 天清理。管理接口将内部失败映射为安全错误，不返回 SDK 错误。

## 实现一个 Adapter

1. 在 `src/main/channels/` 实现 `CommunicationAdapter`，由 Main 将 `AdapterRegistration` 传入 `CommunicationHost`。用 `host.service.addConnection(adapterId, config, credentialRef)` 在可信装配层创建连接；未知 adapterId 在初始化连接前被拒绝。非敏感配置按平台 schema 校验，秘密仅进入凭据库。
2. `start(context)` 只做一次连接动作。明确可重试的失败抛 `AdapterConnectionError(true)`；在线连接失效调用 `context.disconnected(retryable, safeCode?, retryAfterMs?)`。公共模块决定退避和次数；平台提供的等待时间同时适用于连接重试，不受本地 60 秒退避上限缩短。`stop()` 可重复并释放 SDK；必须遵守 AbortSignal。旧代次回调一律拒绝。
3. Adapter 先验证平台原始协议、Webhook 签名和原始大小，再转换为 `inboundEventSchema`。不要传 SDK 对象。connectionId 由 context 闭包绑定，不来自平台正文；平台稳定用户 ID 才能授权，昵称只用于本地核对。
4. 调用 `await context.receive(event, opaqueCursor)`；无法映射身份时调用 `receiveRejected(envelope, opaqueCursor)`，不能将 schema 校验失败当作已确认。仅在 `persisted` 或 `rejected` 后确认 Webhook / 推进 polling offset。`failed` 必须允许重投。公共仓储将游标和 Inbox 在同一事务保存，Adapter 不另存未经确认的游标。
5. `encode(text)` 无网络副作用，完成平台转义、长度计算及确定性分片，声明 `encodingVersion`。编码先持久化再发送。每片段最长为能力上限，总数最多 64，回复正文最多 65,536 单元。附件首版不准入；edit / interactions 声明不授予业务权限，首版仍只聚合最终答复。
6. `send(target, part, identity, signal)` 只执行一次平台发送，关闭 SDK 隐式重试。返回标准 `sent`、明确未发送的 `retry`（可带等待毫秒）、`failed` 或 `uncertain`。禁止把网络超时当成确定未发送。edit 是预留可选契约，当前聚合模式不调用。
7. 不访问业务数据库、Agent、任意内部 session，也不自行绑定、选择回复目标或重试业务。所有发送必须使用冻结 target。凭据明文只能由 Main 凭据库读取并直接交给 SDK，不进入 Core、Renderer、日志或 Python。

## Telegram 首版

- 使用固定 `https://api.telegram.org` 的 `getMe`、`getWebhookInfo`、`getUpdates`、`sendMessage`；不接受自定义 URL、重定向、SDK 隐式重试或公网监听。响应按流限制 2 MiB，单个更新限制 256 KiB；异常不保留 Token URL、平台描述或 cause。
- 创建和凭据轮换通过 `getMe` 绑定稳定 bot ID，同 Bot 创建及管理操作串行。轮换先停止旧代次，只接受原 Bot；创建和轮换后需手动启动，显式启动过的连接在应用重启后自动恢复。创建提交失败清理新凭据文件，启动时仅清理经仓储核对无引用的凭据文件。
- 启动核验 Bot 身份及 webhook，已有 webhook 或外部 polling 冲突时进入安全错误，须解决后手动启动。每次单一长轮询，`timeout=20`、`limit=20`、`allowed_updates=["message"]`，逐条持久化再推进版本化、绑定 bot ID 的 offset。失败不越过本批更新，不清零游标、不丢弃平台积压。
- 仅普通人类私聊文本，身份和时间严格校验安全整数。非文本、编辑、非私聊或无可靠身份的更新走持久化拒绝。正文只取顶层 text，给本 Bot 的命令仅规范化 `@username` 后缀，其他 Bot 的命令拒绝。Telegram `language_code` 不改变桌面语言。
- `telegram` 注册显式启用无参数 `/start` → `/help` 的公共控制别名；仍须绑定。带参数 `/start` 不消费绑定码或票据，也不进入普通对话。其他 Adapter 不受别名影响。
- 出站 `telegram-plain-v1`：纯文本、不设置 parse mode、不预览链接，每片最多 4,000 UTF-16 单元，确定性分片可还原原文，不拆代理对；同 chat 至少间隔 1 秒，连接级至少间隔 40 ms，取消及等待计入单次发送预算。
- 每片只调用一次 `sendMessage`，核验返回消息 ID 与冻结私聊 target。明确 429 尊重完整 `retry_after`；发起后的网络故障、5xx 或无法核验的回执为 uncertain，不自动重发。人工重试须确认可能重复发送，仅重试保存片段，不重跑 Agent。
- 删除先关闭准入、撤销绑定、取消活动任务并抑制待发，再有界停止和清理凭据。停止或清理失败仍在桌面显示并允许重试，不宣告完成或启动替代消费者。保留已提交学习结果与账本。JSON 记录新增字段兼容现有 v15，无需新迁移；验证未打开真实用户数据库。

凭据库使用系统 safeStorage 和权限受限的独立文件，仅提供 write / Main read / remove。加密不可用（含 Linux basic_text）时失败，不降级明文。替换凭据先停止旧代次。设置页的测试由 Main 读取已保存的凭据，并通过 `getMe` 核验 Bot 身份，凭据不会返回桌面。测试不启动轮询。新建连接保存添加时间，旧记录缺少时间时显示「添加时间未知」。

首次添加 Bot 成功后自动生成绑定码并弹窗提醒绑定账号；编辑 Token 或重新进入设置页不弹出提醒。卡片支持生成／重新生成绑定码、复制 `/bind <绑定码>` 命令和查看有效时间，绑定权限为普通对话与句子收录。用户先启动连接，再用自己的 Telegram 账号私聊 Bot 发送命令。设置页打开且有渠道时，每 2 秒刷新运行和绑定状态。卡片展示待确认账号的显示名称与稳定用户 ID，必须在桌面明确确认才建立绑定。绑定码保持原有 5 分钟有效期、尝试次数与摘要存储规则，明文仅保存在当前设置页内存中，离开页面后可重新生成，旧码随之失效。快照提供运行标记、自启意愿、绑定数量及有效挑战的 ID、到期时间和候选账号。无需数据库迁移。

## QQ 单聊首版

- 在 QQ 开放平台启用 WebSocket 和单聊权限。保存 AppID 与 AppSecret 后，测试连接验证凭据和网关地址，启动后等 READY，随后用 QQ 单聊发送绑定命令并回到桌面确认。新绑定默认允许普通对话和 `/sentence` 句子收录。若只想允许普通对话，可在生成绑定码前取消勾选句子收录。解绑立即撤销该账号权限。
- QQ 随桌面进程在线，每次打开应用后手动启动。收到 READY 时先保存初始游标，之后与安全入站回执一同推进游标。进程内重连从最近保存的游标恢复，补发完成后开放出站。网关返回 4004 时，下一次重连会重新获取 AccessToken。收到无安全身份、背压或存储失败时停止本代次。只接收普通单聊文本。
- 回复使用冻结的单聊 OpenID、原消息 ID、截止时间及片段序号。当前使用 5 分钟窗口，每片最多 1,000 UTF-16 单元、每条最多 4 片。超过片数时以桌面界面语言提示截断。明确限流可用原片段重试，发出后失联或平台报告序号重复时保留不确定状态。
- 真实平台验收、窗口和文本长度的核对记录见 [QQ 机器人接入计划](plans/2026-11-05-qq-bot-integration.md)。

## 契约测试和验证

`src/core/communication/__tests__/test-adapter.ts` 提供最终文本和支持交互的两个无网络 Adapter。`adapter-contract.ts` 导出 `runCommunicationAdapterContract(name, makeHarness)` 作为可复用契约入口，`adapter-contract.test.ts` 用两个测试 Adapter 执行；`communication.test.ts`，另覆盖绑定、跨连接隔离、票据重放、取消、游标故障、队列、退避、uncertain、重启、正文清理和有界退出。新 Adapter 应使用可控传输替身跑同一行为，并补充其转义、验签、原始载荷和 SDK 无重试测试。

`tests/integration/communication-agent.test.ts` 对两个测试 Adapter 及真实协议映射的 Telegram 和 QQ Adapter 均使用真实 Python JSONL 和真实 ConversationModule / sentence 领域存储，用可控模型验证无重复执行、稳定消息关联、报告恢复及外发隐私。数据库迁移测试只打开临时数据库；Main / Preload / 设置页测试验证可信来源、凭据不回读、双语空状态和键盘焦点。

应用退出先关闭通信准入、调度及发送，取消渠道业务、有界等待并释放 Adapter，随后关闭 Agent、仓储及日志。晚到回调不再访问仓储。禁用公共模块不会改变桌面原 IPC 及 Python 执行路径；不清空账本或回滚已提交业务。

运行非 E2E 的项目验证命令见实施计划。真实平台需单独完成真实私聊收发、验签、游标重投、账号绑定、发送不确定性、断网、系统休眠及退出验收。任何 E2E 和真实用户数据库操作仍需单独取得用户明确许可。

2026-11-04 验证记录：Telegram 协议／传输／生命周期单元测试、公共 Adapter 契约、管理 IPC 与双语组件测试、真实 Python 普通对话与 sentence 集成均使用替身传输和临时数据。非 E2E 项目检查结果见[实施计划](plans/2026-11-04-telegram-bot-integration.md)。E2E 未执行，按约定默认无问题；真实平台及其他 OS 尚未验收。
