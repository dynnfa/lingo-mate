# LLM 请求 Token 用量记录计划

- 日期：2026-09-07
- 状态：已实施（2026-09-07）
- 目标：通过统一 LLM 通信入口，为每次真实 LLM 请求持久化一条用量记录，包含调用时的 model、输入 token、输出 token 和总 token，可在应用重启后查询；业务调用方无需读取 usage 或管理记账生命周期。

## 当前实现

以当前源码为准，已有三个真实调用入口，均通过 `createModelClient` 创建 OpenAI-compatible Chat Completions 客户端，SDK 自动重试已关闭：

| 入口     | 文件                                      | 当前行为与缺口                                                                                               |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 普通对话 | `src/core/llm/remote-language-model.ts`   | 流式响应；未请求 usage，schema 未提取 usage/model，遇到 `finish_reason: stop` 立即退出，可能漏掉尾部用量分片 |
| 词汇分析 | `src/core/llm/llm-vocabulary-analyzer.ts` | 每个待分析词调用一次工具调用接口；只读取并校验工具结果，未保存响应 usage                                     |
| 连接测试 | `src/core/llm/model-connection-tester.ts` | 使用待测试配置发起非流式请求；只判断正文是否存在，未保存 usage                                               |

`createModelClient` 当前只负责构建原始 SDK 客户端，不管理请求执行或响应消费。共享该工厂并不能保证所有调用自动记账，需要将实际 SDK 调用收敛到统一客户端。

`ConfiguredLanguageModel` 在每次生成开始时解析配置快照；词汇任务通过 runtime factory 固定批次配置。当前词汇反馈由本地 formatter 生成，不额外请求 LLM；`LocalLanguageModel` 也是模拟回复，二者不计入真实请求账本。

应用已有 `lingo-mate.sqlite`，由 Main 创建连接并注入仓储。当前迁移版本为 v5，实施时使用下一未占用版本。现有词条中的 `model_id` 是词条来源，不能替代逐次请求记录。

## 记录口径

1. 一次实际调用 `chat.completions.create` 对应一个独立 `id`。一个词汇批次可以产生多条记录；用户重试产生新记录，不覆盖原调用。
2. 三个入口全部接入。参数校验失败、未配置模型、发送前已取消、命中词库而跳过分析等未调用客户端的情况，不创建真实请求记录。
3. 在调用前固定模型信息：`model_id` 必填，取本次实际发送的 `model` 参数，不在完成时重新读取设置。连接测试使用测试草稿的 model。
4. 若提供方响应返回 model，额外保存 `response_model_id`，用于区分请求别名与响应标识；不得覆盖 `model_id`。响应未提供时为 `NULL`，不推断底层部署模型。
5. 用量以提供方返回的 `usage` 为准：`prompt_tokens → input_tokens`、`completion_tokens → output_tokens`、`total_tokens → total_tokens`。不通过正文长度或本地 tokenizer 伪造计费用量。
6. 缺失值保存 `NULL`，明确表示未知；显式返回的 0 保存为 0。只有 input/output 都有效而 total 缺失时，允许相加得到 total，并标记来源为 `derived`。
7. token 字段必须为非负安全整数，缺失或非法字段不能令正常回复失败。局部有效字段可以保留，数据质量通过 `usage_status` 区分；提供方 total 与 input/output 不一致时保留原值并标记 `invalid`，不静默修正。
8. 请求成功、失败、超时或取消均记录。失败不代表未消耗 token；已有有效 usage 必须保留，未收到则保持未知。请求状态只表达通信请求及响应消费的结果，与业务校验结果、usage 完整性分别表达。
9. 首版不计算费用、不增加统计页面或导出入口、不补算历史记录。保留按 model 和时间查询所需的数据与索引。

## 数据模型与持久化

新增 `llm_request_usage` 表，使用应用现有数据库连接，独立于会话消息与词条事务：

| 字段                | 类型 / 约束      | 含义                                                             |
| ------------------- | ---------------- | ---------------------------------------------------------------- |
| `id`                | TEXT PRIMARY KEY | 本次模型调用 ID，与会话 requestId 分离                           |
| `operation`         | TEXT NOT NULL    | `conversation` / `vocabulary_analysis` / `connection_test`       |
| `model_id`          | TEXT NOT NULL    | 调用时发送的 model 快照                                          |
| `response_model_id` | TEXT NULL        | 提供方响应中的模型标识                                           |
| `started_at`        | INTEGER NOT NULL | UTC 毫秒时间戳                                                   |
| `finished_at`       | INTEGER NULL     | 终态时间；运行中为空                                             |
| `status`            | TEXT NOT NULL    | `started` / `completed` / `failed` / `cancelled` / `interrupted` |
| `input_tokens`      | INTEGER NULL     | 输入 token                                                       |
| `output_tokens`     | INTEGER NULL     | 输出 token                                                       |
| `total_tokens`      | INTEGER NULL     | 总 token                                                         |
| `usage_status`      | TEXT NOT NULL    | `reported` / `derived` / `partial` / `missing` / `invalid`       |
| `error_code`        | TEXT NULL        | 安全枚举错误码，包含超时，不存原始异常文本                       |

- 通过 CHECK 约束保护状态枚举和 token 非负整数范围；Core 校验与数据库约束保持一致。
- 索引采用 `(model_id, started_at)`；首版不额外引入提供方目录、模型配置表或汇总表。
- 发起请求前插入 `started` 记录，在请求终态时按同一 ID 更新。终态更新必须幂等，迟到回调不能重复插入或改写既有终态。
- 重启时将遗留的 `started` 标记为 `interrupted`，`finished_at` 保持未知，不把恢复时间冒充真实结束时间，也不自动重发请求。
- 不为会话或词条设置级联删除关系；删除业务数据不应顺带抹除已发生的调用用量。
- 记录只包含上述元数据，不保存 API Key、请求头、完整 Base URL、Prompt、用户文本、工具参数或模型正文。

## 分层与采集设计

### 统一通信入口

在 `src/core/llm/llm-client.ts` 新增轻量 `LlmClient`，封装现有 OpenAI-compatible Chat Completions SDK。首版只提供非流式 `complete` 和流式 `stream` 两个明确类型的方法，不引入通用中间件框架或 HTTP 拦截器。

```text
RemoteLanguageModel / LlmVocabularyAnalyzer / ModelConnectionTester
    ↓ 请求参数 + operation + signal + timeoutMs
LlmClient.complete / LlmClient.stream
    ├─ SDK 请求、响应消费、取消与超时
    ├─ 请求 model 快照、response model、usage 解析
    └─ LlmUsageRecorder → LlmUsageRepository → SQLite
```

- 两个方法接受类型明确的请求参数与调用上下文；`operation` 必填，`model_id` 直接取实际发送参数。流式方法内部固定 `stream: true` 及用量请求选项，非流式方法固定 `stream: false`，避免参数与消费方式不一致。
- 非流式方法返回 completion；流式方法返回由客户端管理的异步分片迭代器，不向调用方暴露原始 SDK stream。业务层可以读取正文、工具调用等响应内容，但不读取或保存 usage。
- 所有生产代码中的 `chat.completions.create` 只能出现在 `LlmClient` 内；原 `createModelClient` 的 SDK 构建逻辑移入该模块并保持内部使用，业务适配器不再获取原始 SDK 客户端。
- `LlmUsageRecorder` 仅供 `LlmClient` 使用，统一创建 ID、记录起止时间及幂等收尾；每次实际请求持有独立的记录上下文，不维护共享的“当前请求”或“当前用量”。业务适配器不注入 recorder、不手动 begin/finish，也不需要为记账包装业务逻辑。
- 在 `src/core/llm/` 定义 `LlmUsageRepository` 窄接口、记录类型和纯 usage 解析函数。Core 不直接导入 SQLite 或 Electron。
- `src/database/sqlite-llm-usage-repository.ts` 实现插入、终态更新、启动恢复及按模型/时间的分页读取。迁移加入 `src/database/migrations.ts`。
- Main 创建仓储和 recorder，并组装客户端工厂；该工厂按配置快照创建 `LlmClient`，复用同一 recorder。`ConfiguredLanguageModel`、词汇 runtime factory 和连接测试组装点通过工厂取得客户端，连接测试必须使用草稿配置。配置变化不影响正在执行的请求。
- `ConfiguredLanguageModel` 仅负责配置解析和依赖传递。三个业务适配器保留 Prompt 组装、输出语言指定、正文/工具结果校验及业务错误映射；`LanguageModel.streamReply` 仍只输出正文文本。
- 首版不新增 Renderer、Preload 或 IPC 能力。未来展示统计时，再在 Shared 定义安全 DTO 并通过 Main/Preload 暴露窄接口，静态文案同步中英文国际化。

### 请求状态与业务结果

账本的 `status` 由统一客户端确定，不等待业务校验，也不接受业务层回写：

| 状态 | 判定 |
| ---- | ---- |
| `started` | 已进入实际 SDK 调用流程，尚未得到通信终态 |
| `completed` | 非流式响应正常返回，或流式响应自然消费结束，且未发生取消、超时或通信错误 |
| `failed` | SDK 请求失败、传输/解码错误、流式媒体类型不符或请求截止时间到达；超时使用安全错误码 `TIMEOUT` |
| `cancelled` | 外部取消，或调用方在流自然结束前关闭迭代器；提前关闭使用安全错误码 `CONSUMER_CLOSED` |
| `interrupted` | 启动恢复时发现上次进程遗留的 `started`，真实结束时间未知 |

- `completed` 不代表生成内容满足业务要求，也不保证 usage 完整。词汇工具参数非法、模型在正常响应中拒绝回答、连接测试正文为空，都可产生 `completed` 记录，同时由业务层返回失败。服务端以 HTTP 错误拒绝请求则属于 `failed`。
- `finish_reason` 是否符合当前任务、正文是否为空、工具名称或参数是否合法，属于业务校验。流正常结束后，即使这些校验失败，也不将账本改为 `failed`。
- 业务消费中途抛错导致迭代器关闭时，通信记录为 `cancelled / CONSUMER_CLOSED`，保留当时已采集的 usage。不把业务异常文本写入账本，也不为获取尾部 usage 在关闭后继续后台消费。
- 首版不新增业务结果字段；调用方已有的业务返回值和错误处理继续负责表达业务成败。统计请求成功率时必须遵循上述通信口径。

### 流式请求

1. `LlmClient.stream` 负责实际 SDK 调用及整个响应消费周期，校验 SSE 媒体类型，增加 `stream_options: { include_usage: true }`。不能只在 `.create()` 返回 stream 时结束记账。本地已安装 SDK 类型支持该字段，兼容提供方仍需通过 fixture 和实际能力验收。
2. 客户端在每个原始分片交给业务层之前独立解析 usage 和 model，覆盖 `choices: []` 的尾部用量。usage 为请求快照，不逐分片相加；后续有效报告更新快照，缺失报告不清空已有用量，重复报告不重复累计。非法字段按记录口径处理，不能因 usage 校验失败中止正文消费。
3. `RemoteLanguageModel` 收到 `finish_reason: stop` 后标记正文结束，不再输出后续正文，但不得 `break` 或关闭客户端迭代器；继续迭代到自然结束，让客户端采集尾部 usage。客户端本身不将 `stop` 当作通信结束，也不实现对话特有的正文规则。
4. 将当前对话适配器中的通信截止时间、外部取消监听和流资源清理归入客户端；超时覆盖建连及整个 SSE 消费过程，包括 stop 后的尾部。适配器保留正文完整性检查和对用户安全的错误映射。
5. 客户端在 `finally` 中释放流和监听器，并确保记录只收尾一次。自然结束才可记 `completed`；提前关闭记 `cancelled`，网络异常或超时记 `failed`。SDK 将 abort 转为正常迭代结束时仍检查自身取消/超时状态。
6. 缺少 usage 本身不导致失败；异常结束仍保存已采集用量。首版不因兼容服务拒绝 `stream_options` 而自动重发，该请求按通信失败记录；未来若增加兼容重试，每次实际调用必须单独记账。

### 非流式请求与取消协调

- `LlmClient.complete` 在原始 completion 返回后先提取 model/usage，完成通信记账，再将响应交给业务层进行正文、工具名称、工具参数及业务 schema 校验。业务校验抛错不反转已完成记录。
- 词汇并发分析只传请求参数和 `operation: vocabulary_analysis`；记录 ID、usage 快照及终态全部由客户端按请求隔离。本地去重、SQL 写入和结果格式化不产生额外记录。
- 客户端统一处理每次请求的超时和取消，并在调用 SDK 前检查取消状态；未执行 SDK 调用不创建记录。记录起始写入与 SDK 调用之间不引入可被取消打断的异步等待，适配现有同步 SQLite 仓储。
- 词汇领域已有的 `abortableOperation` 可继续承担任务期限及领域取消，但不得负责记账；它的取消信号必须传入客户端。客户端识别并规范化取消原因，区分领域截止时间和用户取消，不在通信层导入词汇领域错误类型。
- 底层 Promise 即使忽略 abort，客户端也必须及时结束等待并收尾，不能依赖迟到响应触发 `finally`。终态竞争使用同一请求上下文仲裁，迟到结果不得新增记录、改变业务结果或改写终态及用量。
- 保持 SDK `maxRetries: 0`。首版账本粒度为一次 SDK 调用；若未来启用 SDK 内部重试，必须先重新设计每次实际请求尝试的采集，不能让一次包装掩盖多次调用。

### 记录失败策略

用量记录是旁路能力：SQLite 插入或更新失败不触发模型重试，不丢弃已经生成的正常回复，也不回滚词条。失败通过不包含用户数据的固定诊断码报告，不静默宣称记账成功。

开始记录写入失败时，收尾可按同一 ID 幂等补写完整记录；仍失败则报告记录失败。更新失败留下的 `started` 可在重启时识别为中断，但不能恢复未落盘的 token。首版不引入常驻队列或第二份持久化日志，因此数据库持续不可写、进程强制退出以及提供方不返回 usage 时，无法保证得到完整数量，必须保留这一可观测性边界。

## 实施步骤

- [x] 1. 定义通信状态、调用上下文、记录类型、仓储接口及纯 usage 解析函数，固定业务结果与通信状态的边界，以及缺失值、派生值和非法值口径。（`src/core/llm/llm-usage.ts`）
- [x] 2. 新增 SQLite 迁移与仓储，完成幂等收尾、启动恢复、模型/时间查询和旧数据保留验证。（迁移 v6 + `src/database/sqlite-llm-usage-repository.ts`）
- [x] 3. 实现 `LlmUsageRecorder` 与 `LlmClient.complete/stream`，统一 SDK 调用、usage 采集、完整流消费、超时、取消、提前关闭和存储失败处理；Main 组装共享依赖及按配置创建客户端的工厂。（`src/core/llm/llm-usage-recorder.ts`、`src/core/llm/llm-client.ts`、`src/main/index.ts`）
- [x] 4. 将流式对话切换到 `LlmClient.stream`，移除适配器自身的通信生命周期管理；stop 后停止正文输出并继续消费，保留正文校验和业务错误映射。
- [x] 5. 将词汇分析与连接测试切换到 `LlmClient.complete`，保留业务校验，接通词汇任务取消信号；核对三个适配器均不读取 usage、不调用 recorder、不直接调用 SDK。
- [x] 6. 完成单元与集成验证及生产调用入口检查，更新计划状态及验证结果。

实施说明（与计划的偏差）：

- `ModelRequestError` 与 `classifyModelRequestError` 从 `remote-language-model.ts` 移入 `llm-client.ts`（通信层错误归类属于统一客户端职责）；适配器从客户端模块导入。
- 通信错误分类后除超时/取消外按原错误重抛（词汇适配器依赖原始 status/message 识别工具能力错误）；SSE 解码失败（SyntaxError）以原始错误传播，账本仍按 `PROTOCOL` 记录。
- 领域截止时间识别通过 `AbortSignal.reason` 的 `code === 'TIMEOUT'` 鸭子类型判断，通信层不导入词汇领域错误类型。

## 测试与验收

单元测试放在对应模块的 `__tests__/`，跨模块测试放在 `tests/integration/`。本次实施没有 UI 交互变化，不专门新增组件测试。客户端测试集中覆盖通信生命周期及记账，业务适配器测试验证输出和业务错误语义；跨模块集成测试验证三个入口经统一客户端落盘。

| 场景                                                   | 预期                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| 普通非流式结果返回 100 / 20 / 120                      | 恰好一行，input=100、output=20、total=120，model 为实际发送值 |
| 流式 stop 后才返回 usage-only 分片                     | 正确保存尾部用量，正文不被追加或污染                          |
| 流中重复 usage                                         | 不累计重复数据，只更新本次记录                                |
| usage 缺失、只有部分字段、显式 0、非法数字、总数不一致 | NULL 与 0 区分，质量状态准确，不影响正文处理                  |
| 响应 model 与请求 model 不同，或请求途中切换配置       | 保存请求快照和独立响应标识，历史记录不随设置变化              |
| 词汇工具结果非法、正常响应中模型拒绝或连接测试正文为空，但含有效 usage | 通信记录为 completed 并保存用量；业务仍按原规则失败，不回写账本 |
| 流自然结束但正文不满足业务完整性规则 | 通信记录为 completed；对话适配器返回业务错误 |
| 业务消费中途抛错并关闭流 | 记录为 cancelled / CONSUMER_CLOSED，保留已采集用量，不继续后台消费 |
| 两个词并发分析，第三项为重复词                         | 两条独立记录，各自用量正确；重复项不产生调用                  |
| 连接测试使用未保存草稿                                 | 保存草稿 model，未改用已保存设置                              |
| 请求失败、取消、超时、流被提前关闭                     | 每次调用至多一个终态，无永久运行状态；未知用量不写 0          |
| stop 后尾部超时或网络失败 | 记录为 failed，保留已知用量；不追加终止标记后的正文 |
| SDK 忽略取消或将 abort 表现为自然结束 | 客户端仍及时按取消/超时收尾，迟到结果不改写状态和用量 |
| 新调用方通过统一客户端发送请求，仅提供必需上下文 | 自动生成记录，无需读取 usage 或调用 recorder |
| 生产调用入口检查 | SDK create 仅存在于 LlmClient；三个适配器不读取 usage、不依赖 recorder |
| 用户重试                                               | 新请求新增一行，旧记录保留                                    |
| 模拟回复、未配置、发送前取消、本地词汇反馈             | 不产生真实模型用量记录                                        |
| 迁移、重启、关闭重开数据库                             | 旧消息与词条保留，用量可查询，遗留 started 转为 interrupted   |
| 记录插入/更新失败及迟到回调                            | 不重发模型请求、不改变业务结果、不重复记账；产生安全诊断      |

实施后的验证命令：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

验证结果（2026-09-07）：全部通过——`pnpm test` 45 个文件 502 个用例；`pnpm lint` 无错误；`pnpm typecheck` 无错误；`pnpm build` 成功；`git diff --check` 干净。生产入口检查确认 `new OpenAI` / `chat.completions.create` 仅存在于 `llm-client.ts`。

完成标准：三个真实请求入口全部经过统一 LlmClient 自动落入账本，业务方只传调用上下文，不读取 usage 或管理记账；通信状态与业务成败分离，每行具有调用时 model；支持已知 token 数与未知状态的准确表达，流式尾部用量不遗漏、并发与重试不串账；重启后数据可按 model 和时间查询，进程隔离与凭据边界保持有效。


## Review 修复验证（2026-09-07）

- 请求守卫在超时或外部取消发生时立即写入终态，释放定时器和监听器；不依赖流从 `yield` 恢复。后续 `next()` 拒绝继续消费，`return()` 不改写第一次记录的状态、时间和用量。幂等写入统一由 recorder 负责。
- 本次新增的 v6 迁移为三个 token 字段补充 `typeof(...) = 'integer'` CHECK，拒绝 SQLite 原本可接受的小数。
- `CreateLlmClient` 返回 `Pick<LlmClient, 'complete' | 'stream'>`；连接测试单元测试使用普通对象替身，通信解码错误由客户端测试覆盖。
- 全量测试 45 个文件、514 个用例通过；lint、typecheck（随 build 执行）、build 和 `git diff --check` 通过。原始暂停消费复现脚本也验证超时立即记为 `failed / TIMEOUT`，后续关闭不改写终态。
