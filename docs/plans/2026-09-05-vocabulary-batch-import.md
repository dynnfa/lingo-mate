# Vocabulary 多单词解析与 SQLite 入库计划

## 状态与目标

- 状态：代码及 JSON mode 适配已实施，自动化与 DeepSeek 真实导入、去重、重启持久化验收通过；内容抽查发现的质量局限见下文。
- 日期：2026-09-05。
- 计划编写日期为 2026-09-05；实施记录更新于 2026-09-07，已修改业务代码。
- 目标：用户一次提交 `apple, banana, orange`，系统拆分多个词条，调用真实 LLM 获取语义、发音说明和音标，校验成功后写入 SQLite 的 `vocabulary` 表，并逐词反馈结果。
- SQLite 是唯一主存储；不同时维护 MD 数据副本。

## 计划编写时的现状与约束

- `src/database/sqlite-conversation-repository.ts` 使用 `better-sqlite3`，已有 v1/v2 迁移、WAL、外键和事务；迁移由会话仓储构造函数执行，使用数据库级 `user_version`。
- `src/main/index.ts` 在 `userData/lingo-mate.sqlite` 创建数据库，并在应用退出时关闭会话仓储。
- `src/core/llm/language-model.ts` 仅有对话用 `streamReply`；`LocalLanguageModel` 是模拟回复，不具备真实词汇解析能力。依赖中已有模型 SDK，不代表模型配置或真实调用已完成。
- `/` 行动目录目前只有 translate、polish、practice；选择后填入命令模板，最终仍按普通对话发送。Vocabulary 必须接入真实业务入口，不能只加展示项。
- 当前只有界面语言设置，没有学习语言设置。界面语言不能被当作词条语言。
- 保持 Renderer → Preload → Main → Core / Database 边界；Prompt、解析校验、去重和存储不放在 React 组件里。
- 工作区已有测试目录迁移等未提交修改；实施时保留这些改动，以当前 `__tests__/`、`tests/e2e/` 布局为准。

## 首版范围与默认决策

以下是可执行的首版方案，其中入口、数量限制、语言范围和音频范围为计划默认值，并非额外确认过的用户要求。

1. 在行动选择器加入 `/vocabulary`，选择后进入明确的词汇录入模式；输入框内容为 `xx, xx, xx`，点击提交才执行，不把任意含逗号的普通消息识别为收藏请求。
2. 词汇录入模式有独立的提交、取消、退出模式及结果区域；结果不是虚构的 assistant 消息，首版不修改会话消息持久化协议。
3. 首版默认支持英语词汇，协议显式携带 `wordLanguage: 'en'`，界面明确展示目标语言。扩展其他语言时增加语言选择及对应规范化规则，不靠 LLM 静默猜测语言。
4. 释义及发音说明使用提交时的界面语言（`zh-CN` / `en`）；Main 解析并固定该批次的语言，运行中切换界面语言不改写已生成内容。
5. “发音”首版指 IPA 音标、口音标记及文字发音提示，不包含可播放音频。若要求朗读，另接词典音频或 TTS，数据库保存资源引用，不让文本模型编造音频链接。
6. 批量提交不要求一次 LLM 调用：首版逐词调用，最多并发 2 个，便于隔离单词失败和重试；不引入通用 Agent 框架或技能加载系统。
7. 正常完成时允许部分成功：通过解析与校验的词条统一在短事务中入库，失败词条不入库。用户取消整个批次时，尚未提交的成功解析结果也不入库。
8. 本期不做词汇编辑、删除、复习算法、向量检索、MD 导出、云同步、自动补全词根或完整词典。

## 输入、拆分与去重

Core 提供纯函数处理原始输入，Main 做协议校验；Renderer 可展示即时提示，但不能成为唯一校验点。

- 接受英文逗号 `,` 和中文逗号 `，`，去除每项首尾空白；忽略空项，忽略后全空则拒绝请求。
- 不按空格拆词，保留 `look up` 等短语；不将分号等任意标点作为分隔符。首版不支持带引号、内含逗号的 CSV 字段。
- 原始输入最多 4,000 字符；拆分后非空项最多 20 个（去重前计数）；每项规范化后最多 100 字符。超限整体拒绝，不截断后静默保存。
- 展示字段 `term` 保留用户大小写；`lookup_key` 使用 Unicode NFC、首尾 trim、连续空白折叠。
- 首版保守地保留大小写及重音：`Apple` 与 `apple` 不强制合并，避免混淆专有名词或缩略词；不做词形还原，`run` 与 `running` 可分别收藏。后续忽略大小写的策略必须显式调整并考虑迁移冲突。
- 同一批次按 `(word_language, lookup_key)` 合并完全重复项，只解析一次；逐输入项返回结果，重复项标记 `duplicate` 并指向第一次出现的 `inputIndex`。
- 入库前先查询已有词条。已存在项返回 `existing`，不请求 LLM，不覆盖释义，也不因为当前界面语言不同而重复插入。
- 数据库唯一约束作为最终防线；并发插入冲突按 `existing` 处理，不使用会删除并重建记录的替换写入。

## 数据模型

在现有 `lingo-mate.sqlite` 中新增名为 `vocabulary` 的表。首版一词条一行；可查询、约束的元数据独立列，词义和发音变体存为受校验的 JSON。

| 字段                      | 类型 / 约束                           | 来源与含义                         |
| ------------------------- | ------------------------------------- | ---------------------------------- |
| `id`                      | TEXT PRIMARY KEY                      | 应用生成 UUID，不由 LLM 生成       |
| `term`                    | TEXT NOT NULL                         | 清理空白后的原始词条               |
| `lookup_key`              | TEXT NOT NULL                         | Core 规范化结果                    |
| `word_language`           | TEXT NOT NULL                         | 请求指定，首版为 `en`              |
| `explanation_language`    | TEXT NOT NULL                         | 本次解析所用界面语言               |
| `analysis_json`           | TEXT NOT NULL，CHECK(json_valid(...)) | 校验后的词义、音标、发音说明       |
| `analysis_schema_version` | INTEGER NOT NULL                      | JSON 结构版本，首版 1              |
| `analysis_source`         | TEXT NOT NULL                         | 首版固定 `llm`，不冒充词典验证结果 |
| `model_id`                | TEXT NOT NULL                         | 实际模型标识，不含地址凭据         |
| `prompt_version`          | TEXT NOT NULL                         | Prompt 版本，首版 `vocabulary-v1`  |
| `created_at`              | TEXT NOT NULL                         | UTC ISO 时间，由应用生成           |
| `updated_at`              | TEXT NOT NULL                         | 首次等于创建时间，预留后续修订     |

约束与索引：

- `UNIQUE(word_language, lookup_key)`；读取结果按 `created_at DESC, id DESC` 稳定排序。
- 建立 `(created_at DESC, id DESC)` 索引支持分页。
- JSON 合法性检查不能代替 Zod 结构校验；写入和读出都按对应结构版本校验。
- 不持久化原始模型响应、未校验的字段、失败占位词条或整个对话历史。

`analysis_json` 的建议结构：

```ts
type VocabularyAnalysis = {
  senses: Array<{
    id: string // 当前词条内稳定、唯一的局部编号，如 s1
    partOfSpeech: string // 使用预定义英文枚举，包含 phrase / other
    definition: string // explanationLanguage
  }>
  pronunciations: Array<{
    accent: 'en-US' | 'en-GB' | 'unspecified'
    ipa: string
    guidance: string // explanationLanguage，文字发音提示
    senseIds: string[] // 对应 senses.id；避免不同词义与读音错配
  }>
}
```

- `senses`、`pronunciations` 均至少 1 项；分别最多 5 项和 6 项；文本字段非空并设置长度上限（释义/说明各 500 字符、IPA 200 字符）。
- 每个词义必须关联至少一个发音；所有 `senseIds` 必须存在，禁止重复词义 ID、悬空引用及未知字段。
- 音标无法可靠给出或输入无法识别时，返回解析失败，不用空值、猜测占位符或输入词本身冒充 IPA。
- 无上下文时只解析常用词义，不承诺穷举；读音相同的词义允许共享发音项。
- Zod 只能保证结构，不能证明释义与 IPA 正确；界面标明模型生成，验收包含人工抽查。

## LLM 解析契约

在 Core 定义可注入的 `VocabularyAnalyzer`，一次解析一个词条，输入包括 `term`、`wordLanguage`、`explanationLanguage`、`AbortSignal`，输出成功解析或明确的不可解析结果。

- 新增专用词汇分析适配器，保留现有 `LanguageModel.streamReply` 和对话行为；不把本地模拟模型包装成真实解析器。
- 接入前确定模型提供方、模型 ID、结构化输出能力及配置来源。凭据仅在 Main/Core 的安全边界内使用，不能出现在计划示例、Renderer、日志或版本库中。
- 未配置真实模型时，返回国际化 `MODEL_NOT_CONFIGURED`，不生成假数据、不写数据库。测试使用依赖注入的 fixture，不隐式回退到假模型。
- Prompt 位于 `src/core/prompt/vocabulary-analysis.ts`；词条作为独立数据传入，不作为系统指令拼接。明确不得执行词条中的指令、不得写数据库、不得扩展成其他词条。
- 每次实际请求明确指定：词条语言、definition/guidance 的输出语言、IPA 标记要求、字段名和枚举稳定为英文。不能只依赖 Prompt 本身的语言。
- 尽可能使用提供方的结构化输出；应用仍对 `unknown` 响应执行严格 Zod 校验。不通过正则从散文中捞 JSON 后直接入库。
- 应用持有输入身份，模型只返回该词的分析或 `unrecognized`，不得决定数据库 ID、时间、语言、去重键、SQL 或保存状态。
- 单词请求超时默认 30 秒，整个批次截止时间默认 120 秒；截止后未完成及未开始项标记 `timeout`，已完成有效项仍可按部分成功规则入库。
- 超时必须同时中止底层请求并使上层等待结束；忽略取消/截止后的迟到结果，不依赖模型 SDK 一定及时响应 AbortSignal。
- 不做自动语义修复或一般错误重试；仅当服务明确返回 HTTP 400 不支持结构化格式时，允许一次切换 JSON mode 的请求，沿用原超时和取消信号。用户可以显式重试失败项。

## 批次执行与事务语义

```text
输入校验 → 拆分与批内去重 → 查询已存在词条
  → 对新词逐词调用 LLM（并发上限 2）
  → 逐词结构与引用校验
  → 检查取消状态 → 短事务写入所有有效新词
  → 按原输入顺序返回逐项结果和统计
```

- 每个提交携带 `requestId`（UUID）；同一窗口一次最多一个活动词汇批次。重复活动 ID 或重复点击返回 busy，不重复调度。
- `saved` 只能在事务成功提交后返回。解析完成但事务失败时，所有本次待写入项返回 `storage_failed`，不能宣称部分已经保存；原有词条不受影响。
- 网络请求绝不放在数据库事务里；事务中仅包含重新检查冲突及参数化插入。
- 正常终态逐项状态：`saved`、`existing`、`duplicate`、`failed`；失败带稳定错误码，批内重复引用源项结果。总数按非空输入项统计，四类计数之和等于总数。
- 总体结果区分 `completed`、`partial`、`failed`、`cancelled`；`duplicate` 的源项失败也算该项未解决，不能凭 duplicate 数量报告成功。
- 取消在提交前生效：停止调度、中止在途请求，丢弃尚未提交的解析结果，整个批次不新增数据；原有 `existing` 记录不会删除。取消后的汇总不把已解析项标为 saved。
- 同步事务开始后不再接受取消；返回 `too_late`，以真实提交结果为准。UI 不得因为点过取消就覆盖已保存结果。
- 窗口销毁和应用退出中止活动批次；丢弃所有迟到结果，清理请求映射/计时器后关闭数据库。
- 重试使用新 requestId，仅提交失败词条；也允许用户重新提交整批，依靠唯一约束和查重跳过已保存词条。
- 首版不持久化批次任务队列：进程在提交前退出则无新增数据；提交后结果未送达时，重试查询已有记录，不重复插入。

## 数据库迁移与生命周期

不能让会话仓储和词汇仓储各自维护一套数据库级 `user_version`。

1. 提取 `src/database/database.ts` 和 `src/database/migrations.ts`，统一打开连接、设置 WAL/外键、执行迁移和关闭连接。
2. 原样保留已有 v1/v2 的迁移语义，在 v3 新增 `vocabulary` 表与索引，不重建或清空现有会话数据。
3. Main 创建一个数据库连接并注入会话、词汇仓储；仓储不再各自迁移或关闭共享连接。退出时先停止业务请求，再由数据库拥有者关闭一次。
4. 每个迁移在事务中执行，成功后才更新版本；高于支持版本时明确失败，不能降级或重新初始化。
5. 覆盖全新数据库、v1/v2 升级、重复启动、迁移回滚和会话读写回归；保持现有启动保护语义。

## 模块与 IPC 边界

| 位置                                                     | 职责                                                      |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `src/shared/vocabulary.ts`                               | 请求/响应 Zod schema、可序列化 DTO、稳定 channel 与错误码 |
| `src/core/learning/vocabulary/parse-vocabulary-input.ts` | 拆分、规范化、批内去重                                    |
| `src/core/learning/vocabulary/vocabulary-module.ts`      | 批次调度、取消、解析校验与保存编排                        |
| `src/core/learning/vocabulary/vocabulary-analyzer.ts`    | 词汇分析接口及领域分析 schema                             |
| `src/core/learning/vocabulary/vocabulary-repository.ts`  | 查重、批量保存、分页读取接口                              |
| `src/core/llm/llm-vocabulary-analyzer.ts`                | 真实模型适配、响应校验、超时与来源信息                    |
| `src/core/prompt/vocabulary-analysis.ts`                 | 有版本的词汇解析指令及显式输出语言                        |
| `src/database/sqlite-vocabulary-repository.ts`           | 参数化 SQL、唯一约束、事务、存储结构转换                  |
| `src/main/vocabulary-ipc.ts`                             | 校验、请求归属、语言解析、安全错误映射与生命周期          |
| `src/renderer/src/vocabulary/`                           | 录入、结果展示和 UI 控制器，不含业务 Prompt               |

通过 `window.api.vocabulary` 暴露窄接口：

- `addBatch({ requestId, text, wordLanguage })`：非流式异步调用，最终返回批次结果，不需要逐 token 事件协议。
- `cancelBatch({ requestId })`：取消属于当前 sender 的活动请求；其他窗口不能取消。
- `list({ limit, cursor })`：读取最小展示投影，默认 50 条、上限 100 条，验证游标，支持重启后核对已存词条。

Main 必须验证 sender 来自应用允许的窗口/主 frame，不能只依靠 UUID；取消和清理复用现有请求归属思路。非法输入在 try/catch 范围内映射为安全错误，避免 Zod/SDK 异常跨 IPC 裸传。

同步更新 `src/preload/index.ts`、`src/preload/index.d.ts` 和当前定义于 `src/shared/conversation.ts` 的 `LingoMateApi`。Shared 不导入 Core 实现；Preload 校验请求与响应，不暴露原始 IPC、SQL、文件路径或模型调用接口。

Renderer 只接收明确允许展示的词条投影与结果，不接收原始仓储对象、用户画像/学习记忆、凭据、完整模型响应或内部异常。日志同样禁止输出用户输入、完整词汇数据和凭据；通过 requestId、错误码等非敏感元数据关联诊断。

## 交互与国际化

- 选择 vocabulary 后显式进入录入模式并聚焦输入框；退出模式恢复普通消息流程。不得改动 translate/polish/practice 的现有行为。
- 普通消息中的 `apple, banana` 仍作为对话发送；仅词汇模式调用 vocabulary API。首版不额外实现自由文本命令解析器。
- 提交后保留原始输入至结果返回；失败或取消保留可修改内容。运行期间禁用重复提交，提供取消按钮。
- 结果展示每个输入项的已保存/已存在/重复/失败状态及汇总，支持重试失败项。错误用稳定 code 翻译，不展示模型原始错误文本。
- 提供简单的已收藏列表，调用 list 接口并在保存后刷新，用于查看语义、音标和发音说明，以及确认重启后仍存在；不扩展为完整词汇管理系统。
- 词汇 UI 状态独立于 ConversationController；切换会话不会把词汇结果附到新会话，也不会启动第二个批次。组件卸载需取消或忽略旧请求，状态更新必须按 requestId 匹配。
- 更新中英文 `conversation` / `common` / `errors` 资源，必要时新增 `vocabulary` namespace 并同步初始化和类型声明；按钮、占位符、汇总、状态、错误及 ARIA 文案全部国际化。
- 动态数量使用插值及复数规则；界面切换语言翻译静态文本，不自动重跑 LLM、不改写历史解析语言。

## 实施步骤

- [x] 1. 确认真实模型提供方与安全配置来源；确认首版英语范围和发音是否需要音频。默认按本计划的文字发音方案开展，不将未配置模型视为完成。
- [x] 2. 定义输入、分析结构、结果 DTO、错误码、去重及取消契约；补齐拆分和 schema 单测。
- [x] 3. 提取共享数据库连接和迁移，新增 v3 vocabulary 表与仓储，完成升级及事务测试。
- [x] 4. 实现有版本的 Prompt 与真实 `VocabularyAnalyzer` 适配器；测试显式输出语言、非法响应、超时、取消，不改现有聊天模型行为。
- [x] 5. 实现 Core 批次编排、并发上限、查重、部分成功、提交和重试语义，使用注入的假分析器测试。
- [x] 6. 接入 Main、Shared、Preload 和应用退出清理；验证来源、所有权、错误转换与边界。
- [x] 7. 接入 vocabulary 行动模式、批量输入、结果与列表展示，补齐国际化和组件测试。
- [x] 8. 完成跨模块和 Electron 验证；人工抽查真实模型输出与重启持久化，记录结果后更新计划状态。

## 测试与验收

### 自动化覆盖

- 输入：英文/中文逗号、连续分隔符、首尾空白、全空、短语、Unicode 等价输入、大小写保留、20/21 项、长度边界。
- 去重：批内重复只调一次 LLM；数据库已有词不调用；重复源项失败时结果与汇总一致；并发冲突不覆盖原数据。
- 模型：缺少释义/音标/说明、非法 JSON、未知字段、错误枚举、无效 senseIds、输出超长、不可识别、凭据缺失、服务失败、请求超时、批次截止、取消后迟到。
- 流程：全部成功、全部已存在、部分失败、全部失败、事务异常回滚、显式重试、请求 busy；失败/取消/未校验结果永不写表。
- 取消与生命周期：排队时、解析时、提交前、提交后取消；窗口销毁、应用退出；恰好一个终态，无永久运行态或资源泄漏。
- 数据库：新库和旧库迁移、重开连接仍能读取词条、升级不丢会话、未知 schema 版本、分页稳定性、JSON 读出校验。
- IPC：非法请求、非应用 sender、跨窗口取消、响应 schema、preload API 隔离；不暴露 SDK/数据库异常、密钥或原始响应。
- UI：一次提交多个词、运行锁定、失败保留输入、逐项结果、重试、列表刷新、语言切换、IME/键盘、旧响应不污染新状态；普通聊天和 slash picker 回归。

单元/组件测试位于被测模块的 `__tests__/`，使用 `*.test.ts(x)`；跨模块用例在 `tests/integration/`，Electron 用例在 `tests/e2e/`。fixtures 仅用于测试，不能成为生产回退。

### 验证命令

实施时执行并记录结果：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:electron
```

### 完成标准

1. 在词汇模式输入 `apple, banana, orange`，每个新词都先经过真实 LLM 和应用校验，再出现在 vocabulary 表中。
2. 列表展示语义、音标和文字发音说明；关闭并重开应用后仍能读取。
3. 再次提交同样词条不重复保存、不重复调用模型；修改界面语言不会增加重复词条。
4. 任一词解析失败时能看到对应错误，其他有效词仍可保存；数据库事务失败时无虚假成功。
5. 取消、超时、窗口关闭不会写入未校验数据或导致 UI 永久等待。
6. 未配置真实模型明确提示且不落库；自动化 fixture 验证不能替代真实模型的功能验收。
7. 既有会话、国际化、进程隔离与数据库迁移测试继续通过。

## 实施记录（2026-09-07）

### 解读与落实的决策

本功能是一条独立于会话消息的词汇录入流程：显式选择 `/vocabulary` → 输入英语单词或短语 → 逐词分析、校验 → 短事务保存 → 展示逐项结果及已收藏列表。普通含逗号消息仍按聊天发送，词汇结果不写入会话历史。

用户已确认复用现有 Settings → Models 配置。当前代码中的模型服务比本计划最初描述更完整，因此沿用 `ModelConfigService`、OpenAI-compatible 协议、已保存的 Base URL / Model ID 和系统安全存储凭据；每批只解析一次配置快照。不读取环境变量作为隐式回退，不创建新密钥。词汇解析始终使用真实远程适配器，不受聊天的显式 local 测试模式影响。

- 首版为英语，提供 IPA、口音和文字发音提示；不含音频。Main 在提交时固定解释语言。
- 模型适配采用 `response_format: json_schema` 严格结构化输出，并独立执行 Zod 结构与词义引用校验。提供方明确返回 HTTP 400 不支持该格式时，切换为 `json_object`，在系统 Prompt 中附上完整 schema 和 JSON 示例；同一批次的分析器记住该模式，后续词条直接使用 JSON mode。模式不跨配置或批次缓存；并发的首次请求可能各自探测一次。两种模式使用同一套 Zod 校验，不提取散文、不自动修复；其他错误不触发切换。接口参考 [OpenAI Structured Outputs 文档](https://developers.openai.com/api/docs/guides/structured-outputs)。
- 并发上限 2，单词 30 秒、批次 120 秒。取消与超时通过独立竞争结束等待，并同时中止底层请求；不会依赖 SDK 是否及时响应。
- 应用拥有共享 SQLite 连接，会话及词汇仓储均不再迁移或关闭连接。v1/v2 迁移逻辑保留，v3 新建 vocabulary 表。唯一冲突不覆盖已有数据。
- Shared 承载分析 DTO 与同一套严格 schema，Core 直接复用；Shared 不反向依赖 Core。批次响应同时校验计数、重复引用和总体结果是否一致。
- 输入、取消、失败重试、结果和分页列表已接入双语界面；保存后刷新列表，组件卸载时取消活动批次，迟到响应按身份忽略。

### 自动化与视觉验证

| 验证                 | 结果                                                                           |
| -------------------- | ------------------------------------------------------------------------------ |
| `pnpm test`          | 36 个测试文件、383 个用例通过，包含 HTTP → 模型适配器 → Core → SQLite 集成测试 |
| `pnpm lint`          | 通过                                                                           |
| `pnpm typecheck`     | Node / Web 均通过；最终 Electron 验证构建也再次执行                            |
| `pnpm build`         | Main / Preload / Renderer 构建通过                                             |
| `pnpm test:electron` | 18 个用例全部通过，其中 3 个为新增词汇端到端用例                               |
| `git diff --check`   | 通过                                                                           |

覆盖输入边界与 Unicode 规范化、结构错误与词义发音关联、不可识别词、缺少模型配置、服务失败、单词/批次超时、两路并发、取消及迟到结果、批内和库内去重、事务回滚、迁移/重开/分页/读出校验、IPC 来源与取消归属、界面状态和普通聊天回归。Electron 验证了词汇保存后重启恢复、切换语言不重跑模型、取消不新增记录以及解析期间关闭窗口后无新增数据。

词汇输入/结果区与已收藏列表的 Electron 截图已检查，主操作按钮、滚动区域和发音说明正常。截图由端到端测试写入忽略目录 `test-results/`，使用测试 fixture，不代表真实模型输出。完整测试所需的本地回环监听在沙箱外执行；未更改应用网络权限或进程隔离设置。

### 真实模型验收记录（2026-09-07）

复用用户在 Settings → Models 保存的 OpenAI-compatible 配置，模型标识为 `deepseek-v4-flash`，配置位置为 `~/Library/Application Support/lingo-mate/models.json`。凭据仅在 Electron 主进程通过系统安全存储解密，没有输出明文或另存凭据。

- 通过真实 Electron 词汇界面提交 `apple, banana, orange`：0 saved、0 existing、3 failed，均为 `MODEL_ERROR`；列表为空，未写入无效记录。
- 针对当前配置发送最小严格 `response_format: json_schema` 请求，服务返回 HTTP 400，错误类型与代码均为 `invalid_request_error`，信息为 `This response_format type is unavailable now`。当前服务不支持该请求格式，尚不能验证释义、IPA 与发音提示。
- 验收工具 Playwright 默认附加 `--use-mock-keychain`，首次启动导致凭据解密失败；临时启动器移除该模拟参数和 `--password-store=basic` 后，真实钥匙串读取成功。没有修改生产代码或用户模型配置。
- 真实批次未能保存，因此其重复提交与重启持久化验收仍待执行；此前自动化 fixture 的相关验证继续有效，但不替代真实验收。

以上为适配前的失败记录。随后用户明确要求增加 JSON mode 并复用当前 DeepSeek 测试，结果如下。

### JSON mode 适配与真实验收（2026-09-07）

- 使用 `response_format: { type: 'json_object' }`，遵循 [DeepSeek JSON Output 文档](https://api-docs.deepseek.com/guides/json_mode/)；仍要求完全满足应用 schema、词义引用与 IPA 基础校验。
- 当前 `deepseek-v4-flash` 真实 UI 导入 `apple, banana, orange`：3 saved、0 failed；重复提交最终复核为 3 existing、0 saved、0 failed。关闭并重启 Electron 后，三个条目的 ID、分析内容与时间均保持一致。
- 当前偏好为英语，返回释义和 guidance 均为英语。抽查 apple `/ˈæpəl/`、banana 美式 `/bəˈnænə/` 与英式 `/bəˈnɑːnə/`、orange 英美 IPA；常见水果释义、重音及词义发音关联基本合理。
- 内容质量局限：apple 的提示把末尾弱读元音类比为 pull 的元音，不够准确；还将大写 Apple 的品牌义混入小写 apple。这些内容通过结构校验，但不能视为权威词典内容。此次功能验收完成，内容质量问题已记录，未静默改写真实模型结果。
- 新增 8 项适配测试，覆盖明确不支持时切换、批次内模式复用、同一取消信号、其他错误不切换、JSON mode 非法数据拒绝和第二次请求失败即终止。全量单元/组件/集成测试 36 文件、391 项通过；lint、typecheck、build 通过。此前 Electron 自动化 18 项通过，本次另执行真实 Electron 导入和重启检查。
- 凭据始终通过主进程系统安全存储复用，没有修改模型配置或导出密钥。
