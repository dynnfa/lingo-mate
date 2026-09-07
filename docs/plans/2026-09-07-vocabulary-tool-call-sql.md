# Vocabulary Tool Call SQL 写入重构计划

## 状态与目标

- 日期：2026-09-07。
- 状态：Implemented（2026-09-07）。`pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test:electron` 已通过；仍需使用用户配置的真实模型做最终人工验收（见文末验收说明）。
- 目标：Vocabulary 通过 LLM tool call 返回可执行的参数化 SQL，应用校验后执行该语句，将结果写入当前 `vocabulary` 表；全面修复代码引用已删除字段的问题。
- 表结构基准：当前工作区 `src/database/migrations.ts` 中的 v5 迁移。该迁移是已有的未提交修改，本计划按其最终 9 个字段设计，不回退到 v3 表结构。本次只新增计划文档，不修改该迁移或业务代码。
- 本计划取代 [Vocabulary 对话 Skill 计划](./2026-09-07-vocabulary-conversation-skill.md) 中的旧词条结构、JSON 文本分析、旧列查重和二次 LLM 结果描述方案；保留 `/vocabulary` 对话入口、输入规则、批次结果和持久化恢复能力。

## 当前问题

现有链路为 `LlmVocabularyAnalyzer → JSON 文本解析 → VocabularyModule → SqliteVocabularyRepository → LlmVocabularyResultDescriber`。分析器读取 `message.content`，结果描述器又调用一次 LLM 生成自然语言回复。

v5 已删除 `lookup_key`、`word_language`、`explanation_language`、`analysis_json`、`analysis_schema_version`、`analysis_source`、`updated_at`，但以下运行时代码仍依赖它们：

| 位置                                                         | 字段或行为错位                                                           | 需要修复的结果                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------- |
| `src/database/sqlite-vocabulary-repository.ts`               | `find()` 查询旧列，INSERT 使用旧列和旧唯一冲突目标，`fromRow()` 要求旧列 | 查重、写入、列表读取全部适配 v5                     |
| `src/shared/vocabulary.ts`                                   | 词条仍要求 `analysis.senses / pronunciations`、词条语言和来源            | 定义对应当前字段的词条 DTO，允许历史内容字段为 NULL |
| `src/core/learning/vocabulary/vocabulary-repository.ts`      | `StoredVocabulary` 仍携带旧列，并把 Prompt 版本锁死为 v1                 | 调整存储接口及版本校验                              |
| `src/core/learning/vocabulary/vocabulary-module.ts`          | 构造旧分析对象及旧存储字段                                               | 暂存已校验的 SQL 命令，在提交阶段执行               |
| `src/core/prompt/vocabulary-analysis.ts`                     | 明确禁止调用工具，要求返回旧 JSON 结构                                   | 改为工具协议与新列语义                              |
| Vocabulary conversation skill、Main 注入、ConversationModule | 写入后再次调用 LLM 描述，重试依赖描述器                                  | 本地化生成实际执行反馈，保留提交后恢复              |

上述问题来自源码与迁移对照，尚未针对用户本机数据库复现。实施时通过仓储回归测试验证，不直接操作用户词库。

## 当前表字段与数据约定

| SQLite 列           | 当前类型 / 约束  | 写入来源与内容                                            |
| ------------------- | ---------------- | --------------------------------------------------------- |
| `id`                | TEXT PRIMARY KEY | Core 生成 UUID，模型不得生成或覆盖                        |
| `term`              | TEXT NOT NULL    | 当前输入项；模型回传值必须与该项一致                      |
| `phonetic`          | TEXT，可 NULL    | LLM 生成 IPA，例如 `/ˈæpəl/`                              |
| `meaning`           | TEXT，可 NULL    | LLM 生成常用含义，多义项保存在同一文本中                  |
| `concept`           | TEXT，可 NULL    | LLM 生成概念、使用场景或语义边界说明                      |
| `example_sentences` | TEXT，可 NULL    | JSON 编码的英语例句字符串数组，例如 `["I ate an apple."]` |
| `model_id`          | TEXT NOT NULL    | 实际请求使用的模型配置快照                                |
| `prompt_version`    | TEXT NOT NULL    | 应用常量，计划使用 `vocabulary-sql-v1`                    |
| `created_at`        | TEXT NOT NULL    | Core 生成 ISO 时间                                        |

`example_sentences` 的 JSON 数组编码是本次确定的应用层约定，当前数据库没有对应 CHECK 约束。新写入必须校验为 1–3 条非空英语例句；不把例句扩成不存在的数据库列。

新生成词条要求四个内容字段非空；建议上限为 `phonetic` 200 字符、`meaning` 2000 字符、`concept` 2000 字符、每条例句 500 字符。音标保留真实性与格式检查，无法可靠识别的词返回未识别结果。读取历史记录时允许四个字段为 NULL，不能因为历史内容不完整导致整个列表失败。非空但不符合例句编码的历史值应作为单条记录的数据错误处理，不能静默丢弃整页；实施前用迁移 fixtures 验证该约定。

公共 DTO 对应为 `id / term / phonetic / meaning / concept / exampleSentences / createdAt`，其中 `exampleSentences` 由仓储解析为 `string[] | null`。`modelId / promptVersion` 留在内部存储类型中。移除旧词条 DTO 的 `analysis / analysisSource / wordLanguage / explanationLanguage`；请求与批次中的 `wordLanguage / explanationLanguage` 仍是合法的运行上下文，继续用于输入限制和 Prompt，不再映射到词表列。

## 目标调用流程

```text
/vocabulary apple, banana
  → Core 解析、规范化、批内去重及库内查重
  → 为每个新词请求一次 LLM，要求返回一个 tool call
  → insert_vocabulary：返回 sql + parameters
    或 vocabulary_unrecognized：返回稳定原因枚举，不写入
  → 校验工具名、参数、SQL 形状及词条内容
  → Core 暂存写入命令
  → Database 在短事务中重新查重、执行返回的 SQL、保存批次报告
  → 根据已提交报告生成国际化反馈，保存 assistant 消息
```

保留当前最多 20 项、双 worker、单词 30 秒和批次 120 秒的限制。每词一次正常请求，已有词零模型调用；一次模型请求只处理一个词，不扩大为模型自主挑选词条的循环。LLM 不再返回用于解析的普通消息正文，也不再负责说明写入是否成功。

## Tool Call 契约

### 写入工具

定义专用 function tool `insert_vocabulary`，参数为严格对象 `sql + parameters`。`sql` 必须为下列唯一允许的语句，工具 JSON Schema 用单值 enum 约束，并由应用再次精确比较；Prompt、工具 schema、运行时验证引用同一内部常量：

```sql
INSERT INTO vocabulary (id, term, phonetic, meaning, concept, example_sentences, model_id, prompt_version, created_at) VALUES (@id, @term, @phonetic, @meaning, @concept, @example_sentences, @model_id, @prompt_version, @created_at)
```

模型返回的 `function.arguments` JSON 示例：

```json
{
  "sql": "INSERT INTO vocabulary (id, term, phonetic, meaning, concept, example_sentences, model_id, prompt_version, created_at) VALUES (@id, @term, @phonetic, @meaning, @concept, @example_sentences, @model_id, @prompt_version, @created_at)",
  "parameters": {
    "term": "apple",
    "phonetic": "/ˈæpəl/",
    "meaning": "苹果，苹果树结出的可食用果实。",
    "concept": "通常指作为食物的苹果果实，可用于日常饮食和购物场景。",
    "example_sentences": "[\"I ate an apple after lunch.\"]"
  }
}
```

收到工具参数后，Core 补入 `id / model_id / prompt_version / created_at`。Database 使用通过校验的模型返回语句执行 `database.prepare(command.sql).run(bindings)`。SQL 与绑定参数共同构成可执行命令，正文中的引号、换行或分号始终作为参数数据传入，不能拼接进 SQL。

模型参数对象不接受额外字段，不能传入系统字段。校验 `term` 与该请求输入项完全一致，不允许替换目标词。参数化 SQL 是本计划对“直接返回可执行 SQL”的实现方式：SQL 本身由 tool call 返回并被执行，模型生成的学习内容通过绑定参数入库。

### 未识别工具与请求行为

- 同时提供 `vocabulary_unrecognized`，只接受 `reason: 'UNRECOGNIZED'`，将结果关联到当前输入项，不接受任意说明文本或 SQL。
- 沿用当前 `chat.completions.create` 客户端与模型配置；设置 `tools`、默认 `tool_choice: 'required'`、`stream: false`（DeepSeek V4 思考模式使用下节的 `auto` 配置），移除 `response_format`、`parallel_tool_calls` 和 `json_schema → json_object` 文本回退。响应侧仍要求恰好一个工具调用。
- 为兼容通用 OpenAI-compatible 接口，工具不发送提供方专属或 Beta 才支持的 `strict` 参数；各对象仍设置 `additionalProperties: false`，所有属性明确 required，并由应用通过 Zod 和 SQL 白名单执行最终严格校验。
- 应用仍独立校验：一个 choice、`finish_reason === 'tool_calls'`、恰好一个 function call、合法工具名、可解析且符合 Zod schema 的参数、无拒绝或截断。出现非空正文、多个工具、未知工具或无工具响应均视为协议错误，不提取正文中的 SQL。
- 不支持该工具协议的提供方返回明确、国际化的能力错误；本次不新增文本 fallback，也不修改普通聊天调用方式。
- 这是一次应用驱动的写入任务。工具执行后由本地报告结束，不追加请求让模型生成最终文本。`tool_call.id` 只用于本次响应关联，持久化恢复仍依赖执行 ID 和批次报告。

### DeepSeek V4 思考模式兼容性（2026-09-07）

DeepSeek V4 默认开启思考模式，该模式拒绝强制 `tool_choice`，并不代表模型不支持工具调用。参见官方文档的[默认思考模式说明](https://api-docs.deepseek.com/guides/thinking_mode/)与[工具参数兼容性说明](https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi/)。旧请求未显式设置思考模式，HTTP 400 被适配器映射为 `TOOL_CALL_NOT_SUPPORTED`，因此界面错误地引导用户更换模型。

对官方 `api.deepseek.com` 端点的 `deepseek-v4-*` vocabulary 请求显式设置 `thinking: { type: 'enabled' }`、`reasoning_effort: 'high'`、`tool_choice: 'auto'` 和 `stream: false`，同时开启思考与工具调用。其他模型/端点仍使用 `tool_choice: 'required'`，不附加这两个思考参数。此设置只作用于 vocabulary 分析器。

`auto` 允许模型不调用工具，但应用仍要求恰好一个合法工具调用；普通文本或无工具响应报 `INVALID_ANALYSIS`，不会写入词库。全部工具参数、SQL 校验保持不变。返回的 `reasoning_content` 不作为正文或入库数据；当前为单次分析请求，无工具结果回传后的后续模型请求。

先前使用当前 `deepseek-v4-flash` 配置和独立合成工具验证了冲突原因：默认模式配合 required 返回 HTTP 400，错误为 `Thinking mode does not support this tool_choice`；仅关闭思考模式后返回 HTTP 200 和一个正常工具调用。该实验不代表新的 enabled + auto 配置已完成真实服务验收。探针未发送项目 Prompt、SQL schema 或用户词库内容，未写用户数据库。更新后的 `tests/integration/vocabulary-deepseek.test.ts` 在 HTTP 边界验证 enabled + high + auto 请求，使用真实 SDK、VocabularyModule 和内存 SQLite 覆盖携带 reasoning_content 的工具响应成功入库、普通文本响应不入库，以及其他模型/端点不携带思考参数的边界。完整真实 vocabulary 请求仍属于文末的最终验收。

## SQL 验证与执行职责

只支持固定的单行 INSERT 模板，因此无需引入通用 SQL AST 解析器或数据库 Agent。SQL 精确匹配常量，不通过删注释、替换关键字、拼接或自动修复来放行其他语句；任何额外语句、表名、列、函数、子查询、UPDATE、DELETE、DDL、PRAGMA 均无法通过模板校验。

- `src/core/llm`：只执行模型请求并解析工具协议，不持有数据库连接。
- `src/core/learning/vocabulary`：定义内部写入命令、内容 schema 和存储接口，校验工具结果，管理词项状态、取消与批次编排。SQL 命令契约放在该内部领域目录，供 Prompt 和数据库适配器引用，不进入公开 IPC DTO。
- `src/database`：实现受控的命令执行入口；在执行边界再次校验 SQL 和完整绑定参数，负责事务、去重、行映射及真实提交结果。
- `src/main`：注入模型配置、仓储和本地化能力。
- Renderer / Preload：继续使用类型化的会话 skill API，不暴露 SQL 执行入口，不接收 SQL、绑定参数或数据库异常正文。

非法工具结果沿用 `INVALID_ANALYSIS` 对外协议码并调整文案为内容生成结果无效，内部保留工具校验失败原因；提供方能力错误使用 `TOOL_CALL_NOT_SUPPORTED` 会话级错误并同步 Shared 与双语资源，不写入简单的词项 `failed` 批次。真实存储异常为 `STORAGE_FAILED`，不得混为未识别词。日志不记录完整 SQL 绑定值、词库内容、模型响应或凭据。

## 查重、事务、取消与恢复

v5 不再有 `(word_language, lookup_key)` 唯一约束，也没有 `term` 唯一约束。必须删除旧 `ON CONFLICT(word_language, lookup_key)`；不能直接改成 `ON CONFLICT(term)`，否则仍会报错。

本次保持字段不变，沿用现有 NFC、首尾空白清理、连续空白归一化、区分大小写的查重语义：

1. 抽取共享的 Core 规范化函数，`lookupKey` 可作为内存值存在，不作为词表列。
2. 仓储以现有 `term` 计算规范化 key；批次预查时读取 `id / term` 建立索引，不再按已删除的列查询。历史库若有相同 key 的多行，按 `created_at ASC, id ASC` 确定返回项，保留全部历史行。
3. 提交使用现有同步 `BEGIN IMMEDIATE` 事务形式；在事务内重新读取并建立当前 key 索引，逐项重新查重。已有则返回原 `id`，新增执行工具 SQL 并即时更新内存索引。两个连接并发写入的回归测试须验证不会重复新增。
4. 预查索引不跨批次长期缓存。当前方案每批次扫描词项，成本为 O(词库大小)，避免在本次引入新的列或改变历史数据；大量词库的索引优化另行评估。
5. 此去重保证覆盖应用的仓储写入入口。所有 Vocabulary 写入必须经过该入口；当前表本身不保证其他写入方的词项唯一性。

新词及 `conversation_skill_executions.batch_json` 继续在同一事务提交。模型只能返回词表 INSERT，执行记录的 UPDATE 由仓储自身代码完成。任意语句或报告写入失败，回滚整个待写入集合；模型阶段部分词失败时，其他已校验词仍可一起提交。零新增也保存报告，`saved / existing / duplicate / failed` 由实际执行结果确定。

显式取消发生在提交前，丢弃待执行命令，零新增；超时沿用有效结果可提交的现有语义。最后一次取消检查与同步事务之间不得插入异步工作。提交后取消或 assistant 消息保存失败不能把已保存结果标记为“未写入”，也不能再次执行 SQL。

重试优先检查已持久化报告：存在报告时只生成并保存本地化回复，未提交时才允许重新调用模型。覆盖数据库已提交、消息尚未保存时退出应用的恢复情形；恢复反馈不要求模型已配置。

## 本地反馈与历史兼容

移除 `LlmVocabularyResultDescriber`、结果描述 Prompt 及其 Main 运行时注入。将 `deterministicVocabularyFacts` 改为统一 i18n 资源驱动的反馈实现，清理 `persistSkillReply()` 中硬编码中英文 fallback；根据已提交报告显示实际新增、已有、批内重复、失败数量和对应词项。批内重复的源词失败时，必须说明没有保存。

每次生成 Prompt 显式指定：`meaning / concept` 使用本次 `explanationLanguage`，`term / example_sentences` 使用英语，`phonetic` 使用 IPA；字段名和工具枚举固定。语言设置仍属于任务上下文，不能借机恢复已删除的语言列。同一词已有其他语言的解释时，继续返回 existing，不隐式覆盖。

为减少执行记录迁移，本次保留已有 `summarizing` 数据库阶段，语义调整为“整理本地结果”；正常新任务不再产生模型描述失败。旧 `description_failed / description_cancelled` 记录仍可读取，重试统一进入本地报告恢复流程。消息持久化失败保留报告与恢复资格，不依赖“最后一条未回答 user”作为唯一判断。后续清理这些历史枚举属于独立迁移。

v5 当前把旧行四个内容字段置 NULL，并删除旧 `analysis_json`。本计划不自动重新生成历史内容，也不声称旧词义或音标已被保留；已执行 v5 后无法仅靠当前表恢复旧分析。历史 NULL 行必须能查重、分页和参与导入反馈。本次不修改 v5 的数据转换；如后续确需调整已执行版本的结构，应新增迁移，不能只改旧迁移期待它重跑。

## 实施步骤

- [x] 1. 为当前 v5 表建立仓储回归测试，覆盖旧列查询/写入错误及 NULL 历史行；确认最终列集合、类型和索引与计划一致。
- [x] 2. 调整 Shared 词条 DTO、Core 存储类型、仓储行映射、查重与 INSERT 路径，移除运行时代码对旧列和旧唯一冲突目标的依赖；分页继续使用 `created_at / id`。
- [x] 3. 定义唯一 SQL 常量、写入工具和未识别工具、Zod 参数校验及系统字段绑定规则；更新 Prompt 版本与双语输出指令。
- [x] 4. 将分析器改为 tool call 适配器，删除 JSON 正文解析和文本回退，保留超时、取消及安全错误映射。
- [x] 5. 改造 VocabularyModule 暂存命令，通过仓储执行模型返回的 SQL；保留实际结果统计、事务原子性、提交前取消和重试幂等性。
- [x] 6. 移除二次描述 LLM，接入国际化本地结果反馈；同步 Main 注入、ConversationModule、历史任务恢复及必要的 Renderer 状态文案。
- [x] 7. 更新单元测试、集成/Electron fixtures、架构文档，并在旧计划注明被本计划替代的部分；运行完整验证后再将本计划标记完成。

## 测试与验收

| 范围           | 必须覆盖                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 表结构与迁移   | 新库、v4 升级 v5、已处于 v5 的重开连接；9 列与分页索引一致；NULL 历史词条可读、可查重；不要求恢复已删除的分析                     |
| 工具协议       | 正常 INSERT、未识别、纯正文、缺少/多个/未知工具、JSON 参数损坏、额外参数、拒绝、截断、工具能力不支持、超时与取消                  |
| SQL 和内容校验 | 已删除列、第二条语句、其他表、非 INSERT、词项替换、系统字段覆盖全部拒绝；引号/换行/分号作为绑定数据安全写入；例句 JSON 与长度限制 |
| 仓储           | 新字段往返一致，旧 Prompt 版本可读，非法数据不落库；两连接并发重复、历史重复、报告写入失败及后续 INSERT 失败整体回滚              |
| Core           | 全部已有时零模型调用；批内重复、部分未识别或协议错误；报告计数准确；双 worker、显式取消、超时后的有效项提交                       |
| 会话恢复       | 提交后消息保存失败、重启、旧描述失败记录重试；只恢复报告，不再次调用模型或写词库；每次请求只有一个终态                            |
| UI / i18n      | `/vocabulary` 对话入口、中英文反馈与安全错误、源词失败的重复项、取消状态；不展示 SQL 或内部模型配置                               |

沿用 `src/**/__tests__/*.test.ts(x)`、`tests/integration/`、`tests/e2e/` 的测试组织。更新 `tests/integration/fixtures/vocabulary-server.ts` 为真实形状的 `tool_calls` 响应，并断言请求包含工具协议、没有旧 `response_format` 或结果描述请求。

实施完成后运行：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:electron
git diff --check
```

完成标准：对话提交新词后，LLM 通过 tool call 返回 SQL，应用执行该语句写入当前 9 列词表；运行时查询、写入及行解析均不引用已删除列；不通过新增旧列消除错误。实际存储结果决定反馈，纯文本 LLM 响应不会写库，正常流程没有二次描述请求，失败/取消/恢复均不重复写入。

最终使用用户配置的模型验证一次真实 tool call 与持久化往返；fixture 验证不能替代提供方的真实工具兼容性验收。此文档编写阶段不调用真实模型或用户数据库。
