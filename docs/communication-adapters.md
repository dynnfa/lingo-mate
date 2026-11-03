# 公共通信模块与 Adapter 接入

公共模块已提供通信基础设施；生产 Adapter 注册表当前为空，不代表已接入 Telegram、微信、飞书或 Discord。测试只使用内存传输、临时 SQLite 和可控模型；真实平台接入及其 Token 表单需要单独实施和验证。

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

投递：pending → sending → sent / retry_wait / failed / uncertain / suppressed。只有确定未发送的临时错误可自动重试。超时、异常、非法发送回执和重启时的 sending 均为 uncertain，桌面明确勾选可能重复后才能重试。重试使用同一片段、partId 和编码版本，已确认的片段不重发；编码版本变化时保留待处理状态。解绑、逻辑删除连接或过期阻止未发内容；已发记录保留事实。停止连接保留队列和待发结果，下次显式启动恢复；重启不自动连接平台。

错误码包含 UNBOUND、CHALLENGE_INVALID、CONFIRMATION_INVALID、OWNER_MISMATCH、CAPABILITY_DENIED、UNSUPPORTED_SCOPE、UNSUPPORTED_INPUT、EXPIRED、RATE_LIMITED、QUEUE_FULL、EVENT_CONFLICT、BACKPRESSURE、STOPPED 和 STORAGE_FAILED。`rejected` 是已持久化拒绝，`failed` 表示接收未完成。管理接口将内部失败映射为安全错误，不返回 SDK 错误。

## 实现一个 Adapter

1. 在 `src/main/channels/` 实现 `CommunicationAdapter`，由 Main 将 `AdapterRegistration` 传入 `CommunicationHost`。用 `host.service.addConnection(adapterId, config, credentialRef)` 在可信装配层创建连接；未知 adapterId 在初始化连接前被拒绝。非敏感配置按平台 schema 校验，秘密仅进入凭据库。
2. `start(context)` 只做一次连接动作。明确可重试的失败抛 `AdapterConnectionError(true)`；在线连接失效调用 `context.disconnected(retryable)`。公共模块决定退避和次数。`stop()` 可重复并释放 SDK；必须遵守 AbortSignal。旧代次回调一律拒绝。
3. Adapter 先验证平台原始协议、Webhook 签名和原始大小，再转换为 `inboundEventSchema`。不要传 SDK 对象。connectionId 由 context 闭包绑定，不来自平台正文；平台稳定用户 ID 才能授权，昵称只用于本地核对。
4. 调用 `await context.receive(event, opaqueCursor)`。仅在 `persisted` 或 `rejected` 后确认 Webhook / 推进 polling offset。`failed` 必须允许重投。公共仓储将游标和 Inbox 在同一事务保存，Adapter 不另存未经确认的游标。
5. `encode(text)` 无网络副作用，完成平台转义、长度计算及确定性分片，声明 `encodingVersion`。编码先持久化再发送。每片段最长为能力上限，总数最多 64，回复正文最多 65,536 单元。附件首版不准入；edit / interactions 声明不授予业务权限，首版仍只聚合最终答复。
6. `send(target, part, identity, signal)` 只执行一次平台发送，关闭 SDK 隐式重试。返回标准 `sent`、明确未发送的 `retry`（可带等待毫秒）、`failed` 或 `uncertain`。禁止把网络超时当成确定未发送。edit 是预留可选契约，当前聚合模式不调用。
7. 不访问业务数据库、Agent、任意内部 session，也不自行绑定、选择回复目标或重试业务。所有发送必须使用冻结 target。凭据明文只能由 Main 凭据库读取并直接交给 SDK，不进入 Core、Renderer、日志或 Python。

凭据库使用系统 safeStorage 和权限受限的独立文件，仅提供 write / Main read / remove。加密不可用（含 Linux basic_text）时失败，不降级明文。替换凭据先停止旧代次；桌面协议只有提交接口和 hasCredential，不提供秘密回读。平台特有 Token 表单和连接创建 UI 留给具体平台。

## 契约测试和验证

`src/core/communication/__tests__/test-adapter.ts` 提供最终文本和支持交互的两个无网络 Adapter。`adapter-contract.ts` 导出 `runCommunicationAdapterContract(name, makeHarness)` 作为可复用契约入口，`adapter-contract.test.ts` 用两个测试 Adapter 执行；`communication.test.ts`，另覆盖绑定、跨连接隔离、票据重放、取消、游标故障、队列、退避、uncertain、重启、正文清理和有界退出。新 Adapter 应使用可控传输替身跑同一行为，并补充其转义、验签、原始载荷和 SDK 无重试测试。

`tests/integration/communication-agent.test.ts` 对两个 Adapter 均使用真实 Python JSONL 和真实 ConversationModule / sentence 领域存储，用可控模型验证无重复执行、稳定消息关联、报告恢复及外发隐私。数据库迁移测试只打开临时数据库；Main / Preload / 设置页测试验证可信来源、凭据不回读、双语空状态和键盘焦点。

应用退出先关闭通信准入、调度及发送，取消渠道业务、有界等待并释放 Adapter，随后关闭 Agent、仓储及日志。晚到回调不再访问仓储。禁用公共模块不会改变桌面原 IPC 及 Python 执行路径；不清空账本或回滚已提交业务。

运行非 E2E 的项目验证命令见实施计划。真实平台需单独完成真实私聊收发、验签、游标重投、账号绑定、发送不确定性、断网、系统休眠及退出验收。任何 E2E 和真实用户数据库操作仍需单独取得用户明确许可。
