# Telegram Bot 通信适配集成计划

状态：开发已实施（非 E2E 验证完成；E2E 与真实平台验收待单独许可）

日期：2026-11-04

依据：[公共通信模块与 Adapter 接入](../communication-adapters.md)、[项目架构](../architecture.md)及仓库 `AGENTS.md`。本计划描述后续实现，不代表当前已支持 Telegram。

## 1. 目标与首版范围

让用户在桌面端配置自己的 Telegram Bot，通过已绑定的 Telegram 私聊使用 Lingo Mate 已开放的远程学习能力。桌面应用运行且连接在线时收发消息；退出或休眠期间不提供常驻云端服务。

| 项目     | 首版决定                                                                                    |
| -------- | ------------------------------------------------------------------------------------------- |
| 接入方式 | Main 中通过 Telegram 官方 HTTPS Bot API 长轮询；不开放公网监听端口                          |
| 账号模型 | 用户自行通过 BotFather 创建专用 Bot，在桌面输入 Token；同一 Bot 在本应用只允许一条有效连接  |
| 入站范围 | 人类用户发起的普通私聊文本；身份使用稳定用户 ID，不按昵称或 username 授权                   |
| 远程业务 | 普通文本对话、`/sentence <原文>`，沿用 `chat` / `sentence` 授权                             |
| 控制命令 | `/bind <绑定码>`、`/help`、`/new`、`/cancel [requestId]`；`/confirm <票据>`仅复用既有验证器 |
| 出站形式 | 聚合已提交的最终文本，确定性分片、纯文本发送，不推送思考过程、工具内容或流式草稿            |
| 恢复方式 | 沿用精确消息 ID / sentence 执行报告恢复；不自动重放业务，不自动重连重启后的平台连接         |
| 语言设置 | 入站时冻结界面、讲解和目标学习语言；Telegram `language_code` 不覆盖桌面设置                 |

暂不包含群聊、频道、话题、Business Bot、inline mode、Mini App、按钮交互、编辑消息、附件、语音和 `/tts`，也不扩大 vocabulary、phrase、synonym、explore 等远程技能白名单。不新增 Agent 策略、Prompt、TS Agent 直跑或 Python 协议权限。

`/start`需要专门处理：将**无参数**的 `/start`作为通信层帮助入口，仍执行现有绑定准入；未绑定用户在桌面引导下发送 `/bind`。带参数 `/start`不解析为绑定票据、不当作普通对话。该规则通过公共通信控制层的显式配置接入，Adapter 不直接发送欢迎消息。首版不提供绑定 deep link，也不自动修改 Bot 的全局命令菜单。

## 2. 当前基础与需要补齐的部分

以下事实以编写计划时的仓库为准：

- `CommunicationService` 已实现连接状态机、两步绑定、Inbox、调度、Outbox、取消、恢复和容量控制；复用其预算与安全边界。
- `CommunicationHost` 支持注入 `AdapterRegistration`，但 `src/main/index.ts` 未传入生产注册项。
- Core 有 `addConnection`，当前 shared / IPC / preload 没有连接创建接口；设置页只有已有连接的管理功能，没有 Telegram Token 表单。
- Main 凭据库已有 safeStorage 加密、拒绝明文降级和 Token 替换前停止旧连接的基础逻辑。
- `AdapterContext.receive`要求可转换为 `inboundEventSchema` 的事件；缺少真实 actor / chat 的更新不能直接套用该 schema。schema 校验失败返回 `failed`，不能据此推进 polling offset。
- 现有标准事件的 `EVENT_CONFLICT` 分支返回 `rejected`，但没有同步更新游标；实现前需用测试明确其持久化证据与确认语义，避免 Adapter 误把任意拒绝当作新事件已安全落盘。
- 当前设置快照没有平台身份与安全错误原因；需要添加最小展示字段，不能返回 Token、游标、正文或内部 session。

不重建已有通信框架。只补齐生产 Telegram 传输、必要的管理接口及接入暴露的公共契约缺口；数据库仍由宿主仓储管理。

## 3. 架构与代码归属

```text
Telegram 私聊
    ↕ HTTPS getUpdates / sendMessage
Main: channels/telegram（协议校验、转换、传输）
    ↕ AdapterContext / CommunicationAdapter
Core: communication（绑定、权限、Inbox、调度、Outbox）
    ↕ BusinessPort
ConversationModule / sentence → 既有 Python Agent Engine

Renderer 设置页 → window.api.communication → 可信 IPC → CommunicationHost
                                                     ↘ Main 凭据库
```

| 位置                                                         | 计划修改                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `src/main/channels/telegram/`                                | `telegram-adapter.ts`、`telegram-transport.ts`、`telegram-protocol.ts`、`telegram-encoding.ts` 及对应 `__tests__/` |
| `src/main/communication/`                                    | Telegram 连接创建、身份核验、凭据更换、删除协调；复用凭据库与可信 IPC 注册                                         |
| `src/main/index.ts`                                          | 静态注册 `telegram` Adapter，注入固定传输实现，保留现有退出顺序                                                    |
| `src/core/communication/`                                    | 最小传输拒绝接收契约、必要连接管理方法、显式控制别名；复用公共状态机                                               |
| `src/database/`                                              | 持久化拒绝回执、平台身份和连接管理所需的兼容性；若确需 schema 变化，新增增量迁移                                   |
| `src/shared/communication.ts`                                | Zod 管理协议、安全错误码及最小连接快照                                                                             |
| `src/preload/communication-api.ts`、`index.ts`、`index.d.ts` | 同步窄 API 与类型，不暴露通用 HTTP / IPC 能力                                                                      |
| `src/renderer/src/settings/channels/`                        | Telegram 创建表单、凭据替换、连接身份和删除交互；hook 使用 camelCase 文件名                                        |
| `src/shared/locales/{zh-CN,en}/communication.json`           | 同步双语文案、错误、引导与无障碍标签                                                                               |
| `tests/integration/`                                         | Telegram 替身传输接入真实通信仓储、ConversationModule 和 Python JSONL 的集成测试                                   |

首版选用可注入的轻量 HTTPS 传输，不引入带自动 polling / retry 的 Bot 框架。生产固定访问 `https://api.telegram.org`，请求方法使用白名单，不允许 Renderer 或平台消息指定 URL、代理、文件路径或命令。关闭自动重试及重定向；响应体按流限制大小后再解析，异常只转换为安全分类。

## 4. 连接、Token 与身份生命周期

1. 设置页提供“添加 Telegram Bot”，说明通过 BotFather 创建 Bot、需要桌面保持运行，以及首版私聊和能力边界。Token 使用密码输入框，仅在提交期间存在于表单内存，提交后清空；不进入浏览器持久化或遥测。
2. 新增明确的 `createTelegramConnection` 管理接口，只接收 Token 和必要非敏感配置，不接受任意 adapterId、endpoint 或 credentialRef。Main 校验长度和格式；格式仅用于拒绝明显无效输入，不替代平台验证。
3. 创建阶段在 Main 通过有界 `getMe` 核验凭据，取得稳定 bot ID 和 username；核对本地同 Bot 重复连接。创建、替换和删除按连接 / Bot 身份协调，并发提交不能产生重复连接或双轮询。
4. Token 仅写入 Main 凭据库，Core 只持有引用；明文不进入 SQLite、Python、快照或日志。Bot API URL 自带 Token，禁止记录完整 URL、原始请求对象和异常 cause 链中的秘密。
5. 创建时先完成必要核验、写加密凭据，再持久化 stopped 连接及绑定的 bot ID；数据库提交失败清理新凭据文件。进程崩溃留下的无引用文件在安全核对后清理，不删除仍被引用的文件。
6. 用户显式启动后，`start(context)`在公共 30 秒连接期限内完成一次身份和 webhook 状态检查，再启动单个可取消 polling 循环后返回；不能等待整个循环结束。既有 webhook 非空时报告配置冲突，不自动删除、不丢弃平台积压。
7. Token 轮换先停止并等待旧代次清理，核验新 Token 仍指向原 bot ID，再替换凭据；失败保留可用旧引用且不自动恢复连接。换成另一 Bot 必须新建连接，不沿用旧绑定、游标或待发结果。
8. 相同 Bot 被外部程序轮询导致冲突时停止当前代次，展示安全原因，要求用户排除冲突后手动启动；不与另一消费者持续争抢。
9. 新增逻辑删除接口：先阻止准入、撤销绑定、取消活动请求、抑制未发投递，再有界停止传输；保留已提交业务和历史账本。凭据清理失败可安全重试，停止失败时不能宣告已完成删除或启动替代实例。

平台身份、可展示 username、脱敏状态原因可以进入快照；密钥仅有 `hasCredential`。不提供凭据回读。加密不可用或 Linux `basic_text` 时明确失败，禁止明文降级。

## 5. 入站校验、映射与游标提交

### 5.1 轮询策略

每个连接只允许一个 `getUpdates` 在途请求，每批按 update ID 顺序逐条接收，禁止并行处理后直接确认整批。初始建议 `timeout=20` 秒、`limit=20`、`allowed_updates=["message"]`；HTTP 截止略大于轮询等待，仍保持有界。以上为本项目配置选择，不能改写公共 `LIMITS`。

Telegram 将 offset 之前的更新视为确认，且 polling 与 webhook 互斥；Adapter 只能从已持久化的最后安全回执计算下一 offset。平台积压有保留期限，本地仍按现有 5 分钟入站有效期决定是否执行业务。[官方更新接收说明](https://core.telegram.org/bots/api#getting-updates)

明确区分：正常空轮询后继续下一次请求；网络或服务错误终止本代次循环并调用 `disconnected(retryable)`，交由公共模块退避；不能在 Adapter 内另建失败重试循环。

### 5.2 标准消息映射

| Telegram 字段                    | 标准字段 / 处理                                                    |
| -------------------------------- | ------------------------------------------------------------------ |
| `update_id`                      | 十进制字符串 `externalEventId`；去重按 connectionId 隔离           |
| `message.message_id`             | 十进制字符串 `externalMessageId`，只与冻结 chat 一起使用           |
| `message.from.id`                | 十进制字符串 `externalActorId`，校验为真实非 bot 用户              |
| `message.chat.id`                | 十进制字符串 `externalConversationId`，不从文本或转发元数据取目标  |
| `message.chat.type` / topic 字段 | 映射真实 scope / thread；非普通私聊不得降级为 private              |
| `message.date`                   | 校验整数并转换为毫秒 `occurredAt`；不以本地接收时间覆盖旧消息时间  |
| `message.text`                   | 原文传入；复用 4,000 UTF-16 单元限制，不静默截断或拆成多次业务请求 |
| 用户显示名                       | 可选、限长且仅供桌面核对；不参与授权和路由                         |

所有数字 ID 在原始 JSON 层校验安全整数，禁止 32 位转换。正文仅取顶层 text；不拼接回复引用、转发内容、附件 caption 或 entities 中的 URL。明确发送给本 Bot 的 `/command@bot_username`只规范化命令 token；发给其他 Bot 的命令被拒绝，参数与普通正文不改写。

建议限制单次轮询响应为 2 MiB、单个更新为 256 KiB，作为传输保护常量并用边界测试固定。有效载荷的额外平台字段允许受限存在，所使用的身份、时间、正文必须严格验证；不把原始 SDK / JSON 对象交给 Core。

### 5.3 持久化拒绝与安全确认

实施前先为公共接收层补齐以下行为测试和最小契约：

- 可以可靠映射的附件、编辑、服务消息和不支持 scope 走既有标准事件拒绝路径；超长或空文本不能依赖标准 schema 返回 `failed` 后直接跳过。
- 对只有可靠 update ID、无法形成业务身份的更新，新增 Main 专用的 `AdapterContext.receiveRejected(envelope, cursor)`。envelope 仅含稳定事件 ID、受限分类和摘要；Core 写入无业务正文的拒绝墓碑，并与游标同事务提交，不虚构用户、chat 或业务 session。
- 拒绝入口不授予绑定、业务执行或出站权限。没有真实冻结 target 的事件不产生 Outbox。受连接代次、容量、去重和保留期限约束，不能成为无限拒绝日志。
- 相同 ID、相同规范化摘要重投返回原回执；同 ID 不同内容保留冲突证据并原子提交可确认游标，不覆盖原事件、不产生第二次业务执行。标准事件和传输拒绝共享事件唯一性。
- 稳定摘要排除显示名等可变展示信息；未知事件不持久化整个原始对象。若需要新增记录结构，采用增量迁移并只使用临时数据库验证。
- 缺少可靠 update ID、响应超限、JSON 损坏等无法安全形成拒绝记录的情形，不猜测 offset；停止本代次并报告安全错误，避免无限热循环或静默丢消息。

逐条调用 `receive`或 `receiveRejected`时，候选游标携带版本、bot ID 和当前 update ID 对应的下一 offset，仅由公共仓储落盘。只有 `persisted`或已完成持久化的 `rejected`才更新内存安全游标；任一 `failed`立即停止本批，后续事件不能越过该事件。数据库失败和 BACKPRESSURE 不确认平台传输。

重启从 `context.cursor`恢复，不在文件、SDK 或进程全局另存 offset。游标版本、bot ID 或格式不匹配时明确失败，不自动清零，也不使用负 offset 或 `drop_pending_updates`跳过消息。崩溃发生在落盘与平台确认之间时允许重投，交由 Inbox 去重。

## 6. 出站编码、限速与发送结果

声明 `edit=false`、`interactions=false`、`attachments=false`，`encodingVersion=telegram-plain-v1`。首版 `encode(text)`输出 `format=plain`，不设置 `parse_mode`，不用 Markdown / HTML 转义规则重写正文。Telegram 的 `sendMessage`有单条文本长度限制，本项目保守选用每片段最多 4,000 UTF-16 单元。[官方发送说明](https://core.telegram.org/bots/api#sendmessage)

- 分片优先换行，其次空白，再在 Unicode code point 边界切分，不拆 UTF-16 代理对。连接片段应还原原文，不裁剪内容、不插入动态序号；覆盖 emoji、组合字符、CJK、长行和 Markdown 符号。
- 复用回复总长 65,536、最多 64 片段及编码先落盘约束。重试保持相同 partId、内容和编码版本，不重发已确认片段。
- `send`只能使用 Outbox 冻结 target；校验目标为首版可用私聊路线，不采信文本中的 chatId、username、迁移目标或 payload 中的任意路由。
- 每次 `send`最多一次 `sendMessage`调用，不发 typing、欢迎消息或额外兜底回复。关闭链接预览，避免学习材料中的链接自动产生预览请求。
- 注入可取消时钟，为同 chat 串行发送设置至少 1 秒间隔；跨 chat 使用连接级有界节流。等待计入公共 30 秒单次发送预算，确定尚未发起请求且预算不足时返回 `retry`，不在传输层偷偷重试。
- `deliveryId/partId`用于本地审计；不假定 Telegram 接受客户端幂等键，不声称网络发送可以做到 exactly-once。

| 传输结果                                                     | 标准回执及后续                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| 校验通过的成功响应，含真实 message ID 且 chat 与 target 一致 | `sent`，保存外部消息 ID                                      |
| 明确的限流拒绝                                               | `retry`，校验 `retry_after`并转换为毫秒；等待交由公共 Outbox |
| 能证明请求尚未发出的临时故障                                 | `retry`；无证据时不得使用此分类                              |
| 明确永久拒绝，例如无效 Token、禁止发送、目标不可用           | `failed`；鉴权失效同时使连接进入不可重试错误                 |
| 发起请求后超时、断线、取消，响应损坏或成功回执无法核验       | `uncertain`；不自动重发                                      |
| 5xx / 非标准网关响应                                         | 默认 `uncertain`；只有证明未发送的情形才能降为 `retry`       |

`retry_after`是平台提供的重试等待信息，不能用本地 60 秒退避上限缩短平台要求的等待。[官方响应参数](https://core.telegram.org/bots/api#responseparameters)

`uncertain`仅允许桌面用户明确勾选可能重复后重试已保存片段；不再次调用 Agent。Token、HTTP 原始错误、失败请求正文和模型内部信息不得出现在远程错误回复中。

## 7. 桌面交互、权限与语言

用户路径：创建专用 Bot → 提交 Token → 显式启动 → 创建绑定码 → 在 Bot 私聊发送 `/bind <码>` → 桌面核对稳定账号 ID → 确认绑定 → 私聊使用。

- 默认只授予 `chat`，`sentence`通过已有显式勾选授予；远程命令、菜单展示及 Token 有效均不能代替绑定或授权。
- 展示 bot username、连接状态、安全错误原因、`hasCredential`、账号 ID 和权限；支持凭据替换、停止、解绑、逻辑删除及既有投递处理。
- 区分“Adapter 已安装但无连接”和“未安装 Adapter”的空状态。表单校验、提交失败、加密不可用、webhook 冲突、重复 Bot、外部轮询冲突均使用静态错误码映射双语文案。
- 创建后保持 stopped，Token 替换后需再次显式启动；应用重启不自动连接。明确休眠期间消息可能因有效期被拒绝，不承诺补执行所有离线消息。
- 绑定码继续使用 128 bit 随机源、5 分钟期限、5 次尝试和数据库摘要；不写明文码、不按昵称自动确认。
- 不承诺未绑定账号收到欢迎或拒绝回复；当前未绑定拒绝不产生授权 Outbox，桌面通过绑定回执引导用户。
- `/new`、`/cancel`、确认票据及语言上下文完全复用既有规则。票据消费不等于获得新的学习操作授权，不在 Adapter 中推断用户意图。
- 中英文资源同步更新，使用 i18n 插值。目标语言准入仍复用项目支持列表，不能因接入 Telegram 宣称支持更多学习语种。
- 保留设置页进入 / 退出的焦点管理、键盘提交和错误焦点；离开表单即清空 Token。Renderer 只使用窄 API，不调用 Telegram 或读取文件。

## 8. 实施顺序与阶段验收

核心逻辑、状态和 IPC 均按 TDD：先写可观察行为的失败测试，确认失败原因，再实现并重构。以下阶段按顺序执行，不以测试替身通过代表真实平台接入完成。

### P1：补齐公共接收与管理契约

- [x] 为无法形成标准事件的更新、冲突拒绝与游标原子提交增加失败测试。
- [x] 实现最小 `receiveRejected`、共享去重和墓碑清理；保持 storage failure / capacity exhaustion 不确认。
- [x] 增加创建 / 逻辑删除、平台身份及安全错误协议；复用可信 IPC 守卫，同步 preload 类型。
- [x] 明确 `/start`控制别名及命令后缀规范化规则，不扩大远程能力。
- [x] 用临时 SQLite 验证原有 v15 数据兼容；若必要，编写新的增量迁移，禁止手改旧迁移。

验收：无 Token、正文或内部路由泄漏；任何确认的更新都有可恢复证据和持久化游标；原有两个测试 Adapter 的行为不变。

### P2：Telegram 协议与传输

- [x] 完成原始 schema、大小限制、安全数字 ID、事件映射和版本化游标测试。
- [x] 实现 `getMe`、`getWebhookInfo`、`getUpdates`、`sendMessage`固定方法的可注入传输。
- [x] 覆盖 Token URL 脱敏、禁止重定向、请求截止与单次发送无隐式重试。
- [x] 实现纯文本确定性编码、限速及标准发送分类。

验收：测试不访问真实 Telegram；HTTP 替身能控制超时、限流、坏回执和请求是否已发出。

### P3：Adapter 生命周期与 Main 装配

- [x] 实现单代次 polling、逐条提交、failed 阻断本批和断线通知。
- [x] 实现可重复 stop、AbortSignal、3 秒有界停止及旧代次回调拒绝。
- [x] 静态注册 Adapter，接入创建、相同 bot ID 的凭据轮换、重复 Bot 防护及逻辑删除。
- [x] 确认退出先停止通信，再关闭 Agent / 仓储；不改变桌面请求归属和渠道请求取消规则。

验收：停止 / 重连 / 替换 Token / 删除竞争时最多一个消费者；清理失败不创建替代实例；重启保持 stopped。

### P4：设置页与国际化

- [x] 添加 Telegram 创建表单、身份展示、凭据替换、逻辑删除和针对性错误提示。
- [x] 补齐双语引导、空状态、Token 清理和键盘焦点组件测试。
- [x] 复用绑定、权限勾选、取消及 uncertain 投递处理，不另建远程管理权限。

验收：用户可完整完成桌面配置和绑定；任一快照或错误响应均不能读回 Token。

### P5：契约、集成与真实验收

- [x] 用可控 Telegram 传输运行 `runCommunicationAdapterContract`，经过真实协议映射，不能绕过 Adapter 直接注入 Core。
- [x] 增加 Telegram → 通信模块 → ConversationModule / sentence → 真实 Python JSONL 的集成覆盖；模型使用可控替身，SQLite 使用临时实例。
- [x] 完成下述非 E2E 检查；更新 `communication-adapters.md`，准确区分已实现、替身验证和真实平台验证。
- [ ] 单独取得许可后执行 E2E 和真实平台验收，记录实际结果与未验收项。
- [ ] 全部计划工作及相关验证完成后，将本计划状态改为“已实施”。

## 9. 验证矩阵与命令

| 层级                | 关键场景                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| 协议 / 编码单元测试 | 4,000 / 4,001 单元、emoji、CJK、超大响应、坏 JSON、不安全整数、未知字段、非文本、其他 Bot 命令、私聊 topic |
| Inbox / 仓储        | 持久化拒绝、冲突、重复、批中失败、容量上限、游标事务回滚、崩溃后重投、旧消息过期、墓碑保留                 |
| 连接 / 安全         | 无效 Token、webhook 冲突、不同 Bot 凭据拒绝、相同 Bot 并发创建、密钥库不可用、旧代次晚回调、停止失败       |
| Outbox              | 确定未发、429、长等待、5xx、发送后超时、坏成功回执、部分分片已发、手动 uncertain 重试、解绑后抑制          |
| IPC / 组件          | 不可信来源、严格输入与返回 schema、非本地 ID 注入、无密钥回读、Token 清理、中英文、焦点、可重复删除        |
| Python 集成         | 普通文本与 sentence 各执行一次、精确消息关联、报告恢复、取消与窗口关闭隔离、失败不回退、禁止技能不进入模型 |
| 隐私回归            | 对外只含已提交最终文本；错误、日志、快照不暴露 Token、游标、内部工具和模型思考                             |

首次准备环境或 Python 锁文件变更后先执行 `pnpm agent:sync`；全量 TS 测试前也要确认锁定 Python 环境已同步。之后执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm agent:protocol
pnpm agent:test
pnpm agent:check
```

本计划不预期修改 Python 策略或 v12 协议。若实施发现必须改变跨语言协议，应先调整范围，从 Zod 源生成 schema、同步契约；破坏性变更提升版本，涉及运行包 / 启动 / 分发时再执行 `pnpm agent:build`与 `pnpm agent:smoke`，遵循目标平台原生构建要求。

真实验收使用用户明确同意的测试 Bot、账号和隔离临时数据目录，逐项验证绑定、普通对话、sentence 授权、长回复、取消、断网恢复、休眠唤醒、退出、重启不自动连接及发送不确定性；不能为了验证超时而自动重发业务。真实验收结果单独记录，不以单平台通过替代其他目标 OS 验收。

执行任何 E2E（含真实平台端到端验收）前必须单独询问并取得明确许可；未获许可不执行，记录“E2E 未执行，按约定默认无问题”，不作为阻塞项，也不声称真实平台已验收。若仍有未授权验证，应在交付中保留说明，不将全部检查项标为完成。真实用户数据库迁移或持久化变更另需事先询问；开发启动也不能绕过，默认只使用可丢弃测试数据库。

## 10. 回退与后续范围

出现平台兼容或发布问题时停止 Telegram 连接或移除生产注册项，保留通信账本、已提交学习结果和凭据恢复信息；不得通过清库、清游标或自动重放恢复。桌面原有业务路径不依赖 Telegram 在线。

后续独立计划再评估 webhook、按钮确认、流式编辑、语音及更多技能。Webhook 模式需重新设计公网生命周期、秘密头校验与确认语义；音频和多阶段学习任务需分别审计恢复证据、结果投影和权限，不能仅将 Adapter capability 开关设为 true。

## 11. 平台资料

平台行为核对日期：2026-11-04。上述长轮询、纯文本、预算与权限范围是本项目的首版设计选择；实现时应再次核对官方文档，不依赖未经验证的 SDK 默认值。

- [BotFather 与 Bot 创建管理](https://core.telegram.org/bots/features#botfather)
- [Bot API 请求与认证](https://core.telegram.org/bots/api#making-requests)
- [getUpdates](https://core.telegram.org/bots/api#getupdates)、[getWebhookInfo](https://core.telegram.org/bots/api#getwebhookinfo)
- [getMe](https://core.telegram.org/bots/api#getme)、[sendMessage](https://core.telegram.org/bots/api#sendmessage)
- [Update](https://core.telegram.org/bots/api#update)、[ResponseParameters](https://core.telegram.org/bots/api#responseparameters)

## 12. 本次实施记录

分支：`codex/telegram-bot-integration`。

P1–P4 已实施；P5 的替身传输契约及真实 Python JSONL 集成已实施。新拒绝墓碑、冲突摘要、平台身份和删除状态均使用 v15 既有 JSON 记录的可选字段，未新增或修改迁移；测试只使用内存／临时数据库。未改变 Python 策略、协议版本或生产远程能力白名单。

验证环境的 `uv` 原先缺失，已安装到 `/private/tmp/lingo-mate-telegram-tools` 并通过 `pnpm agent:sync` 同步锁定环境；无需更改项目依赖或锁文件。全量测试首次在沙箱内运行时，本地替身 HTTP 服务监听被禁止（`listen EPERM 127.0.0.1`），因此需在允许本地监听的环境重跑，不能将该次结果记为通过。

最终非 E2E 验证结果（2026-11-04）：

| 检查                  | 结果                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| `pnpm agent:sync`     | 通过，锁文件不变                                                       |
| `pnpm lint`           | 通过                                                                   |
| `pnpm typecheck`      | 通过，最终 `pnpm build` 同时再次执行                                   |
| `pnpm test`           | 199 个文件、2,198 个测试通过；允许本地 HTTP 替身监听后完整重跑，无跳过 |
| `pnpm build`          | 通过，未启动 Electron                                                  |
| `pnpm agent:protocol` | 通过，v12 与生成物不变                                                 |
| `pnpm agent:test`     | 395 个测试通过                                                         |
| `pnpm agent:check`    | Ruff、格式和严格 mypy 均通过                                           |
| `git diff --check`    | 通过                                                                   |

新增回归还覆盖 v15 旧显示名摘要去重、未完成删除可见且可重试、停止超时不替换消费者、退出时忽略晚到凭据核验、轮询与发送的完整 `retry_after`，以及带参数 `/start` 不消费或明文保存可能的绑定秘密。

E2E 未执行，按约定默认无问题。尚未取得真实测试 Bot／账号和 Electron E2E 的单独许可，未运行应用访问真实用户数据库，也未访问真实 Telegram 凭据。真实私聊绑定、长回复、取消、断网、休眠、退出、重启以及其他目标 OS 仍待真实平台验收；因此保留上述验收项，暂不将整份计划状态标为“已实施”。
