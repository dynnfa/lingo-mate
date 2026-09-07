# LLM 请求 Token 用量记录计划

- 日期：2026-09-07
- 状态：待实施
- 目标：为每次真实 LLM 请求持久化一条用量记录，包含调用时的 model、输入 token、输出 token 和总 token，可在应用重启后查询。
- 本次交付仅为实施计划，不修改运行时代码。

## 当前实现

以当前源码为准，已有三个真实调用入口，均通过 `createModelClient` 创建 OpenAI-compatible Chat Completions 客户端，SDK 自动重试已关闭：

| 入口     | 文件                                      | 当前行为与缺口                                                                                               |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 普通对话 | `src/core/llm/remote-language-model.ts`   | 流式响应；未请求 usage，schema 未提取 usage/model，遇到 `finish_reason: stop` 立即退出，可能漏掉尾部用量分片 |
| 词汇分析 | `src/core/llm/llm-vocabulary-analyzer.ts` | 每个待分析词调用一次工具调用接口；只读取并校验工具结果，未保存响应 usage                                     |
| 连接测试 | `src/core/llm/model-connection-tester.ts` | 使用待测试配置发起非流式请求；只判断正文是否存在，未保存 usage                                               |

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
8. 请求成功、失败、超时或取消均记录。失败不代表未消耗 token；已有有效 usage 必须保留，未收到则保持未知。请求状态与 usage 完整性分别表达。
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

- 在 `src/core/llm/` 定义 `LlmUsageRepository` 窄接口、记录类型和 usage 解析函数；新增轻量 `LlmUsageRecorder`，统一创建 ID、记录起止时间和幂等收尾。
- `src/database/sqlite-llm-usage-repository.ts` 实现插入、终态更新、启动恢复及按模型/时间的分页读取。迁移加入 `src/database/migrations.ts`。
- `src/main/index.ts` 创建并向三个适配器注入同一 recorder；连接测试若在其他 Main 组装点创建，同步传入。Core 不直接导入 SQLite 或 Electron。
- 采集包围实际模型请求及响应消费，usage 必须在业务内容校验之前提取。词汇工具参数非法、模型拒绝或连接测试正文为空，仍可能具有有效用量。
- `ConfiguredLanguageModel` 仅负责传递依赖和配置，不重复记账。保持 `LanguageModel.streamReply` 的正文迭代接口，usage 不混入文本分片。
- 首版不新增 Renderer、Preload 或 IPC 能力。未来展示统计时，再在 Shared 定义安全 DTO 并通过 Main/Preload 暴露窄接口，静态文案同步中英文国际化。

### 流式请求

1. 请求增加 `stream_options: { include_usage: true }`。本地已安装 SDK 的类型定义支持该字段，并说明结束时可能出现不带 choices 正文的 usage 分片；兼容提供方仍需通过 fixture 和实际能力验收。
2. 独立解析每个分片的 usage 和 model，在检查 choice 之前处理，覆盖 `choices: []` 的尾部用量。通常 usage 为累计值，不逐分片相加；用最后一份有效报告更新快照，重复报告不重复累计。
3. 收到 `finish_reason: stop` 后停止输出正文，但继续消费尾部到流结束，以获取最终 usage。终止标记后的正文不得追加到回复。
4. 保留现有超时、取消和完整回复检查；尾部读取也受截止时间约束。缺少 usage 本身不导致失败；网络异常、超时或取消仍按相应终态结束并保存已知用量。
5. async generator 提前关闭也必须在 `finally` 收尾，释放流和监听器；未自然完成的消费不能误报成功。SDK 将 abort 转为正常迭代结束时仍检查取消状态。
6. 首版不因兼容服务拒绝 `stream_options` 而自动重发，避免隐式新增请求；该请求按现有错误映射记失败。若后续增加兼容重试，每次实际调用必须单独记账。

### 非流式请求

- 在原始 completion 返回后先读取 model/usage，再执行正文、工具名称、工具参数及业务 schema 校验。
- 词汇并发分析各自持有记录 ID 和 usage 快照，不共享可变的“当前用量”；本地去重、SQL 写入和结果格式化不产生额外记录。
- 超时封装可能早于底层 Promise 返回，需协调 recorder 与 abortable operation 的终态，只完成一次记录；迟到结果不得新增记录或反转取消/失败状态。
- 保持 SDK `maxRetries: 0`。若未来启用 SDK 内部重试，需要先下沉采集到每次请求的层级，不能让一次业务包装掩盖多次调用。

### 记录失败策略

用量记录是旁路能力：SQLite 插入或更新失败不触发模型重试，不丢弃已经生成的正常回复，也不回滚词条。失败通过不包含用户数据的固定诊断码报告，不静默宣称记账成功。

开始记录写入失败时，收尾可按同一 ID 幂等补写完整记录；仍失败则报告记录失败。更新失败留下的 `started` 可在重启时识别为中断，但不能恢复未落盘的 token。首版不引入常驻队列或第二份持久化日志，因此数据库持续不可写、进程强制退出以及提供方不返回 usage 时，无法保证得到完整数量，必须保留这一可观测性边界。

## 实施步骤

- [ ] 1. 定义记录类型、状态、仓储接口及纯 usage 解析函数，先固定缺失值、派生值和非法值口径。
- [ ] 2. 新增 SQLite 迁移与仓储，完成幂等收尾、启动恢复、模型/时间查询和旧数据保留验证。
- [ ] 3. 实现 recorder，明确取消、超时、提前关闭和存储失败的处理；在 Main 中统一注入。
- [ ] 4. 接入流式对话，调整 stop 后的消费流程，采集 usage-only 分片并保留现有正文与终态行为。
- [ ] 5. 接入词汇分析与连接测试；核对全仓真实模型调用均经过采集，模拟和本地处理不记账。
- [ ] 6. 完成单元与集成验证，更新计划状态及验证结果。

## 测试与验收

单元测试放在对应模块的 `__tests__/`，跨模块测试放在 `tests/integration/`。本次实施没有 UI 交互变化，不专门新增组件测试。

| 场景                                                   | 预期                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| 普通非流式结果返回 100 / 20 / 120                      | 恰好一行，input=100、output=20、total=120，model 为实际发送值 |
| 流式 stop 后才返回 usage-only 分片                     | 正确保存尾部用量，正文不被追加或污染                          |
| 流中重复 usage                                         | 不累计重复数据，只更新本次记录                                |
| usage 缺失、只有部分字段、显式 0、非法数字、总数不一致 | NULL 与 0 区分，质量状态准确，不影响正文处理                  |
| 响应 model 与请求 model 不同，或请求途中切换配置       | 保存请求快照和独立响应标识，历史记录不随设置变化              |
| 词汇工具结果非法或模型拒绝，但含有效 usage             | 失败记录仍保存用量；不依赖词条成功写入                        |
| 两个词并发分析，第三项为重复词                         | 两条独立记录，各自用量正确；重复项不产生调用                  |
| 连接测试使用未保存草稿                                 | 保存草稿 model，未改用已保存设置                              |
| 请求失败、取消、超时、流被提前关闭                     | 每次调用至多一个终态，无永久运行状态；未知用量不写 0          |
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

完成标准：三个真实请求入口均落入账本，每行具有调用时 model；支持已知 token 数与未知状态的准确表达，流式尾部用量不遗漏、并发与重试不串账；重启后数据可按 model 和时间查询，进程隔离与凭据边界保持有效。
