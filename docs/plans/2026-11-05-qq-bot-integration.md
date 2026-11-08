# 腾讯 QQ 机器人接入计划

状态：已完成开发与替身验证，待真实平台验收

日期：2026-11-05

## 1. 目标与首版范围

用户在 QQ 开放平台创建自己的机器人，在 Lingo Mate 桌面端配置并启动连接，完成账号绑定后，通过 QQ 单聊使用普通文本对话和默认授权的 `/sentence <原文>`。机器人随桌面进程在线。桌面退出、休眠或断网期间的消息按平台补发能力和本地有效期处理。

| 项目           | 首版决定                                                             |
| -------------- | -------------------------------------------------------------------- |
| 平台与接入方式 | 腾讯 QQ 官方 Bot API。WebSocket 接收事件，HTTPS 发送被动回复         |
| 入站范围       | `C2C_MESSAGE_CREATE` 普通文本，使用事件中的用户 OpenID               |
| 远程权限       | 两步绑定默认允许 `chat` 和 `sentence`，生成绑定码前可取消句子收录    |
| 控制命令       | 复用 `/bind`、`/help`、`/new`、`/cancel`，已有确认票据沿用公共验证器 |
| 出站范围       | 最终文本和公共控制回复，统一关联触发消息，使用纯文本                 |
| 语言           | 接收时冻结桌面配置的界面、讲解和目标学习语言                         |

后续范围包括 QQ 群聊 `@`、频道、Webhook 部署、主动推送、流式输出和富媒体。群聊涉及独立的群路由、成员授权、会话隔离及回复窗口，需要单独设计。首版保持现有远程学习技能白名单。

## 2. 仓库基础与改动边界

- [公共通信模块](../communication-adapters.md)已提供连接生命周期、绑定、准入、Inbox、Outbox、取消、会话映射与恢复，并已有 Telegram 生产注册和替身验证。QQ 作为第二个静态注册的 Adapter 接入。
- `CommunicationHost` 的创建、测试连接、凭据轮换、快照及设置页目前以 Telegram 为中心。Core 和 IPC 已有启动、停止、绑定和解绑操作，设置页需补上 QQ 用户走通这些操作所需的入口和最小状态。
- 当前 Outbox 冻结收件路由，但 `send` 的入参缺少触发消息 ID、回复截止时间和片段序号。QQ 被动回复依赖这三项，需要扩展公共投递契约并验证旧记录兼容。
- 普通对话与 `/sentence` 经 `ConversationBusinessPort` 复用现有领域入口和 Python Agent。QQ 协议、凭据与投递留在 TypeScript 宿主。Python 协议和任务权限无需扩展。

```text
QQ 单聊 → WebSocket → Main QQ Adapter → Core Inbox / 绑定 / 调度
                                              ↓
                                 ConversationBusinessPort → Python Agent
                                              ↓
QQ 单聊 ← HTTPS 被动回复 ← Main QQ Adapter ← Core Outbox

设置页 → window.api.communication → 可信 IPC → CommunicationHost / 加密凭据库
```

| 位置                                                         | 计划改动                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `src/main/channels/qq/`                                      | QQ 注册、访问凭证、HTTP 与 WebSocket 传输、事件校验、纯文本编码及测试       |
| `src/main/communication/`、`src/main/index.ts`               | 注册 QQ，协调连接、凭据及身份，沿用退出顺序和安全错误映射                   |
| `src/core/communication/`                                    | 扩展原消息回复上下文、截止时间与发送序号，复用公共 Inbox、Outbox 和连接代次 |
| `src/database/`                                              | 验证现有通信 JSON 记录的可选字段兼容；仅在确需结构变化时新增增量迁移        |
| `src/shared/communication.ts`、`src/preload/`                | 新增明确的 QQ 创建和凭据替换输入，更新窄 API、快照与错误 schema             |
| `src/renderer/src/settings/channels/`、`src/shared/locales/` | 平台选择、QQ 表单、启动与绑定流程、中英文状态及引导                         |
| `tests/integration/`                                         | 替身 QQ 网关与 HTTP 接口，接入真实通信仓储、会话领域和 Python JSONL         |

## 3. 官方协议与最小调用

### 开通与鉴权

1. 在 QQ 开放平台创建机器人，在「事件订阅与回调地址」选择 WebSocket，确认机器人有单聊事件权限并配置内部体验账号。开发体验与公开使用的权限以具体机器人后台为准。 [QQ 机器人接入指南](https://bot.q.qq.com/wiki/)
2. Main 调用 `POST https://api.bot.qq.com/app/getAppAccessToken`，请求 JSON 为 `{"appId":"APP_ID","clientSecret":"APP_SECRET"}`。同时校验 HTTP 结果及业务响应，按 `expires_in` 缓存，在到期前刷新。同一机器人并发请求共用一次刷新。 [获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)
3. 使用 `Authorization: QQBot ACCESS_TOKEN` 调用 `GET https://api.bot.qq.com/gateway/bot`，连接返回的官方 WSS 地址。收到 `Hello` 后，使用 `Identify` 和 `GROUP_AND_C2C_EVENT`（`1 << 25`）订阅事件，完成就绪握手后进入在线状态。按服务端间隔维护心跳及 ACK。该订阅位同时覆盖群聊事件，首版只允许单聊进入业务。 [事件订阅与通知](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)

### 单聊收发

| QQ 字段                              | 标准事件映射                                                               |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `t = C2C_MESSAGE_CREATE`             | `scope = private`。按官方消息结构确认是普通文本                            |
| `d.author.user_openid`               | 同时用作 `externalActorId` 和单聊 `externalConversationId`，保留原始字符串 |
| `d.id`                               | `externalMessageId`，原值用于 QQ 被动回复                                  |
| `d.message_scene.ext` 中的 `msg_idx` | 按官方说明与消息 ID 结合形成去重身份，详见入站规则                         |
| `d.timestamp`                        | 严格解析为 `occurredAt`，保持平台原始时间语义                              |
| `d.content`                          | 文本内容，遵守现有 4,000 UTF-16 单元入站上限                               |

映射仅使用通过 schema 校验的顶层消息字段。回复地址和原消息 ID 由可信宿主冻结。 [单聊消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)

```http
POST https://api.bot.qq.com/v2/users/USER_OPENID/messages
Authorization: QQBot ACCESS_TOKEN
Content-Type: application/json

{"content":"你好，我可以帮你练习英语。","msg_type":0,"msg_id":"ORIGINAL_MESSAGE_ID","msg_seq":1}
```

`USER_OPENID` 来自原事件的 `d.author.user_openid`，`msg_id` 取 `d.id`。同一原消息的不同片段按序递增 `msg_seq`，重复发送相同 `msg_id + msg_seq` 会被平台拒绝。当前官方概述给出的单聊被动回复限制为 60 分钟、每条入站消息最多 4 次。 [发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html) · [消息收发规则](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)

## 4. 连接、凭据与入站处理

### 配置与生命周期

- 使用 AppID 作为 QQ 连接的稳定平台身份。Main 在受信调用中用 AppID 与 AppSecret 组合换取凭证并查询网关。创建与测试连接验证凭据和网关访问，实际启动后的 `READY` 才表示网关订阅就绪，收到绑定消息才证明单聊链路可用。
- 每个 AppID 只允许一条有效的本地连接。创建后保持 stopped，显式启动。轮换仅接受同一 AppID 的新 Secret，先停止并等待旧代次清理，验证后切换加密引用。验证或保存失败时保留原引用。更换 AppID 使用新连接及新绑定。
- AppSecret 通过现有 Main 凭据库加密，AccessToken 只在 Main 内存缓存。表单以密码输入框临时接收 Secret，提交后或离开表单时清空。持久化配置仅保存 AppID 和凭据引用。快照、日志、Python JSONL 及管理错误只使用最小公开字段和安全分类。加密不可用时沿用现有失败规则。
- 固定官方 HTTPS 主机和端点，校验网关返回地址的 `wss:`、主机、端口与路径，关闭重定向。为帧大小、解析、握手、缓冲队列和 HTTP 调用设置上限。平台帧和 Renderer 输入都不能指定传输目的地。
- `start` 只执行一次连接尝试，在现有 30 秒期限内等待就绪。断线、心跳超时及网关重连指令交给公共退避；鉴权、权限或回调模式错误转换为明确可见的失败。停止、替换凭据、逻辑删除及退出应清理旧代次 socket、心跳和未完成请求，晚到回调继续由代次检查挡住。应用重启后保持停止。

### 入站、重投与 Resume

- 在 Adapter 中校验封包、OpenID、消息 ID、时间和消息类型。附件、群聊、频道和服务事件走受限的传输拒绝路径，无业务身份的帧使用现有 `receiveRejected`，有安全事件 ID 才能写拒绝回执。禁止把 QQ 群聊伪装成单聊进入 Core。
- 入站去重按连接隔离。用规范化的 `d.id` 和可用的 `msg_idx` 表示业务事件身份，单独保留 QQ 原消息 ID。对重投中 `msg_idx` 缺失或变化的样本，先用官方文档与真实事件确认稳定映射。无法确认同一 `d.id` 是否代表独立消息时，保守拒绝二次执行。网关 `s` 和会话 ID 只参与 Resume，重连后业务去重仍依赖 Inbox。
- 心跳使用网关最近接收的序号，Resume 使用最近持久化安全回执对应的序号。逐条按接收顺序调用 `receive` 或 `receiveRejected`。候选游标包含版本、AppID、网关会话 ID 及序号，与回执在同一事务保存。存储失败、背压或无法形成安全回执时停止本代次，后续事件不得越过失败序号。
- 本次进程内自动重连优先尝试 `Resume`，只接受与当前 AppID 和会话匹配的游标。恢复就绪后再开放出站，补发事件按顺序入库。没有可用游标或平台明确拒绝恢复时，由公共生命周期发起新的 `Identify`。手动启动建立新网关会话，已入库记录仍按原状态恢复。会话失效后的历史补发取决于平台。
- 复用 Core 的 5 分钟入站有效期、速率、队列与绑定检查。重复投递、未绑定账号或无授权命令都不能再次触发业务。连接断线及重启恢复只依据公共状态和已提交的精确消息或执行报告。

## 5. Outbox 被动回复契约

1. **冻结原消息与有效期。** Outbox 入队事务保存可选回复上下文，包含原始外部消息 ID、原事件时间推导出的回复截止时间。发送参数沿用已冻结的收件人和连接归属，并携带该上下文。QQ 出站必须通过上下文校验，截止时间取平台回复窗口与本地投递窗口的较早值。领取、重试、手动处理和发请求前均检查过期。
2. **固化编码和片段序号。** QQ 使用独立编码版本 `qq-c2c-plain-v1`。首版拟设本地上限为每片 1,000 UTF-16 单元，最多 4 片。实现前用当前官方限制与体验账号验证长度和次数，若平台更严则按更严边界设定。优先在换行或空白处切分，保留完整 Unicode 字符。超出预算时，末片包含按语言快照生成的简短截断提示，桌面保留已提交的完整答案。每片 `msg_seq` 从 1 开始，与片段和编码版本一起持久化。
3. **发送一次并分类结果。** Adapter 只用冻结目标和原消息上下文发起一次 HTTPS 请求。校验平台返回的消息 ID 后记为 `sent`。明确限流或可证明尚未发送的临时故障记为 `retry`，尊重平台等待时间和剩余窗口。明确拒绝或过期终止投递。请求发出后超时、断线、取消或成功回执无法核验时记为 `uncertain`。
4. **重试沿用原始身份。** 同一片段重试继续使用原始 `msg_id`、`msg_seq`、内容和 `partId`。平台返回重复序号但缺少可核验的原投递证据时，保留不确定状态。人工重试需确认可能重复，并在回复窗口内仅重发保存片段，禁止重新运行 Agent。过期、解绑或删除连接会抑制尚未发送的片段。
5. **兼容已存记录。** 公共新增字段采用可选、向后兼容的 JSON 形状。旧 Telegram 投递仍走原编码及期限。QQ 投递缺失或损坏回复上下文时终止，禁止自动转为主动推送。测试覆盖关闭后恢复、部分片段成功和同一个序号的重复回执。

出站只取公共投影后的最终回复和安全控制消息。模型思考、工具数据、诊断原文和平台密钥留在各自的可信边界内。

## 6. 桌面配置和绑定

用户路径为「添加通信渠道 → QQ 机器人 → 填 AppID 和 AppSecret → 测试连接 → 启动 → 创建绑定码 → QQ 单聊发送 `/bind <码>` → 桌面核对账号并确认 → 发送学习问题」。

- 设置页新增平台选择，复用公共连接卡片和对话框。连接快照补齐最小的状态、凭据是否已保存、安全错误及绑定确认所需字段。提供停止、解绑、替换 Secret 和删除入口，保留键盘操作及焦点恢复。
- 复用现有绑定码有效期、尝试限制、一次性消费和权限选择。以连接内的 OpenID 识别账号，展示字段只用于用户核对。凭据验证成功、能收到 QQ 消息与获得学习权限是三个独立状态。
- QQ 管理调用经 `registerTrustedHandler` 执行来源、输入、结果及所有权校验。Preload 暴露业务专用 API，Renderer 通过 `window.api.communication` 使用。平台字段与错误码按 QQ 和 Telegram 分支处理，避免把 QQ AppID 当作 Telegram 用户名。
- 同步更新简体中文和英文文案、错误提示及无障碍标签。明确展示应用需要运行、后台单聊权限和回复窗口限制。QQ 平台资料不覆盖桌面语言设置。

## 7. 实施顺序与验收

核心行为、状态和 IPC 按 TDD 实施。每阶段先固定可观察的失败用例，再补实现。

| 阶段            | 工作与完成条件                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 平台契约核对 | 核对官方鉴权、WSS 会话、单聊事件字段、长度、限流及重复序号语义。真实样本等待单独许可，通过脱敏 fixture 固定已确认的协议                                                         |
| P1 公共投递契约 | 增加原消息上下文、截止时间、持久化序号及兼容用例。用临时 SQLite 验证重启恢复、旧 Telegram 记录和既有 Adapter 契约                                                               |
| P2 QQ Adapter   | 实现 Token、网关握手、心跳、重连、入站映射、游标及出站分类。替身传输覆盖重投、错误身份、限流、断线、过期、背压、旧代次和凭据刷新竞争                                            |
| P3 Main 与桌面  | 静态注册 QQ，补齐可信 IPC、状态展示、加密轮换和两步绑定。组件验证双语、焦点、表单清空、状态变化以及 Telegram 回归                                                               |
| P4 集成与验收   | 替身 QQ 平台经真实 Adapter、临时 SQLite、ConversationModule、真实 Python JSONL 和可控模型完成普通对话及 `/sentence`。覆盖权限拒绝、重复投递只执行一次、精确恢复、取消和外发隐私 |
| P5 真实体验     | 获得许可后，使用专用测试机器人、内部体验账号与独立测试数据目录验证登录、绑定、两条连续消息、长文本、重连、解绑及 Secret 轮换。记录平台限制和验收结果                            |

全量 TypeScript 测试前确认锁定的 Python 环境已同步。首次准备或 Python 锁文件变更后执行 `pnpm agent:sync`。实现完成后运行以下检查，真实 Python 集成使用临时数据库和可控模型。

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm agent:protocol
pnpm agent:test
pnpm agent:check
```

任何 E2E 执行前先取得明确许可，包括 `pnpm test:electron`。未获许可时按项目约定记录「E2E 未执行，按约定默认无问题」。涉及真实用户数据库的迁移或数据变更须另行询问。公开支持说明应区分替身验证与真实平台验收。完成全部计划工作和相关验证后，将本计划状态更新为「已实施」。

## 8. 实施记录

- QQ 已注册到桌面通信渠道。使用现有加密凭据库、绑定和 Agent 执行入口，通信 JSON 记录使用可选字段，无需 SQLite 迁移。
- 官方收发概述和单聊发送页面标题写明 60 分钟、每条 4 次，但发送接口的 `msg_id` 字段写明 5 分钟。首版采用较短的 5 分钟有效期，每片最多 1,000 UTF-16 单元、每条最多 4 片。公开文档列出了长度超限错误，未给出纯文本数值上限，片长等待专用机器人验证。[单聊发送文档](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)
- 官方将 `msg_idx` 描述为引用消息索引。入站保存通过校验的索引，并以同一 `d.id` 约束一次业务执行。索引缺失或变化的重投也不会再次执行。使用基于公开协议构造的替身帧，真实样本和稳定性待 P5 核对。[单聊事件文档](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)
- 替身验证使用真实 QQ Adapter、临时 SQLite、ConversationModule、真实 Python JSONL 与可控模型，覆盖权限拒绝、普通对话、句子收录、取消、精确恢复和外发隐私。真实平台体验待单独许可和专用测试机器人。E2E 未执行，按约定默认无问题。
- 项目检查通过：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm agent:protocol` 和 `pnpm agent:check`。全量 TypeScript 测试 2,260 项通过，Python 测试 395 项通过。
