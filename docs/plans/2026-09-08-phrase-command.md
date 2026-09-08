# /phrase 短语收录功能计划

- 日期：2026-09-08
- 状态：已实施

## 目标与范围

借鉴 Vocabulary，新增 `/phrase` 会话技能：用户提交短语，LLM 通过 tool call 提供解释和例句，本地代码校验、去重并写入 SQLite，再根据真实执行结果生成反馈。

首版包含指令入口、批量收录、持久化、取消、失败与重试恢复。沿用目前的英语学习范围；独立短语管理页、编辑删除、多义项和多语言词库不在本次范围。当前「已记录」页仍是骨架，不将其视为已有完整 Vocabulary 列表能力。

**LLM 只决定调用哪个工具及其入参。SQL、数据库访问、事务、去重、执行状态和成功数量全部由本地代码控制。** 不提供任意 SQL、脚本、文件或通用数据库工具，不执行模型正文中的代码。

## 当前代码基线

- `src/core/learning/vocabulary/vocabulary-module.ts`：已有输入解析、预查重、有限并发分析、暂存写入内容、提交与取消流程，可作为 Phrase 领域模块的参考。
- `src/core/learning/vocabulary/vocabulary-insert.ts`、`src/core/llm/llm-vocabulary-analyzer.ts`：已有两个白名单工具、严格参数校验和单次响应协议校验。Phrase 沿用该模式；SQL 直接封装在数据库仓储中，Core 只传递类型化内容。
- `src/database/sqlite-vocabulary-repository.ts`：已有业务数据与技能执行报告在同一事务提交的实现。
- `src/shared/conversation.ts`、`src/core/conversation/conversation-skill-repository.ts` 及其调用方目前限定 vocabulary，需要按 `skillId` 扩展参数和报告类型。
- `src/database/migrations.ts` 当前最新版本为 7；技能 ID 和用量 operation 存在 CHECK 约束，需要追加迁移。
- `src/renderer/src/conversation/conversation-actions.ts` 提供斜杠行动列表和 Vocabulary 草稿解析；新增 Phrase 入口时同步接入 controller、会话展示和国际化资源。

本计划独立于尚未实施的 synonym 计划。实施时以最新代码为准分配迁移版本；若其他技能已接入，扩展已有联合类型及约束，保留全部已有技能。

## 输入与去重

1. 支持直接输入 `/phrase look forward to`，也支持从斜杠选择器选中 Phrase 后输入；均转换为类型化技能请求，不作为普通聊天发送。
2. 每行一个短语，支持批量输入；不按空格或逗号拆分，避免破坏短语内部空格及 `if anything, ...` 等表达。忽略空行，空输入报国际化错误。
3. 初始上限为总文本 4000 字符、每批 20 项、每项规范化后 200 字符；在 Shared/Main 输入边界及 Core 校验，不仅依赖 UI 限制。
4. 规范化采用 NFC、去首尾空白、连续空白归一，沿用 Vocabulary 的大小写敏感规则。规范化后的文本存入 `phrase`，也作为唯一键；原始输入及顺序保存在执行报告中。
5. 本地先标记批内重复，再查询已收录项；已有短语跳过且不覆盖解释或例句，全部已存在时不请求模型。不同大小写视为不同项，首版不做语义去重。
6. 每个待处理短语单独请求模型，只附带当前输入、目标语言和解释语言；不发送整个词库、其他会话或学习记忆。

## 数据模型

新增 `phrase` 表，仅包含需求指定的三个字段。**保留原字段拼写 `explantation`**，数据库、工具协议和共享数据类型统一使用该名称；其含义为 explanation（解释），界面通过翻译资源展示正常标签。

| 字段 | 类型与约束 | 含义 |
| --- | --- | --- |
| phrase | TEXT PRIMARY KEY NOT NULL，非空，最多 200 字符 | 本地规范化后的短语，同时作为条目标识 |
| explantation | TEXT NOT NULL，非空，最多 2000 字符 | 当前短语主要含义及必要的用法说明 |
| example | TEXT NOT NULL，非空，最多 1000 字符 | 一条完整、自然、包含该短语用法的目标语言例句 |

通过本地 schema 与数据库 CHECK 约束拒绝空白内容及超长字段。主键采用大小写敏感比较。首版无需额外 ID、时间或语言列；执行 ID、模型配置和语言快照沿用技能执行与用量记录机制。切换解释语言不重写历史内容。

固定 SQL 仅定义于 `src/database/sqlite-phrase-repository.ts`，例如：

```sql
INSERT INTO phrase (phrase, explantation, example)
VALUES (@phrase, @explantation, @example)
ON CONFLICT(phrase) DO NOTHING;
```

模型内容只作为绑定值；表名、列名和 SQL 结构均不可由模型指定。仓储接口只接收内容对象，不接收 `sql` 字符串。冲突返回 `existing`，其余约束或存储错误必须暴露为失败，不能笼统忽略。

## 工具协议与能力边界

工具定义及入参校验放在 `src/core/tools/phrase-tools.ts`。仅向本次 Phrase 请求暴露以下两个工具，JSON Schema 设置 `additionalProperties: false`，本地使用严格 Zod schema 再次验证。

### insert_phrase

```ts
{ phrase: string; explantation: string; example: string }
```

- 三个字段均必填，满足上述非空和长度限制。
- `phrase` 必须严格等于本地发送的当前规范化短语；不允许改写输入、替换为其他短语或夹带其他条目。
- `explantation` 和 `example` 是模型生成的学习内容；校验其结构和长度，不把通过校验等同于语言知识准确无误。
- 工具执行器仅暂存验证后的内容；数据库成功提交前不标记 `saved`。工具说明须明确写入由本地批次提交决定。

### phrase_unrecognized

```ts
{ reason: 'UNRECOGNIZED' }
```

- 当前输入无法可靠解释为英语短语或惯用表达时调用。
- 本地记录该项未识别，不写业务表；不要求模型为无效输入编造解释。

### 响应与执行规则

1. 每项只接受一次模型响应中的一个白名单 function tool call，不需要查询工具或多轮 Agent 循环。
2. 检查完成原因、拒绝状态、工具数量、工具名称、JSON 和全部字段。截断响应、无工具、多个工具、未知工具、非空正文和非法入参均判定协议失败，不尝试提取正文 JSON 或 SQL。
3. 沿用现有模型客户端的工具调用兼容配置；即使请求使用 `tool_choice: auto`，本地也只接受合法 tool call。模型不支持工具调用时返回明确错误，不回退普通文本生成。
4. 本地执行器采用固定分派，不动态执行函数名。拒绝附加的 `sql`、`table`、`where`、`executionId` 等参数；执行上下文由应用注入。
5. 单项超时初始为 30 秒，批次为 120 秒，最多并发 2 项；取消和超时后丢弃迟到结果，不自动无限重试。
6. Prompt 每次明确指定：phrase 保持原输入，example 使用目标学习语言，explantation 使用本次解释语言；协议名和枚举不翻译。输入被明确标记为待分析数据，不能授予额外工具或更改执行规则。
7. 会话总结使用本地报告和翻译模板，不再调用 LLM，也不采信模型声称的写入结果。

## 事务、取消与恢复

- 执行阶段沿用 `analyzing → committing → summarizing`。分析阶段仅暂存合法内容，不持有 SQLite 事务。
- 分析完成后，在一个本地事务中复查重复、插入所有合法项并保存最终批次报告。单项分析失败允许其他合法项提交，结果为部分成功；提交或报告保存失败时全部新增写入回滚。
- 事务内通过唯一约束处理并发和重复提交。对同一 execution 的重放优先读取既有报告，不重复调用模型或写入。
- 提交前用户取消则丢弃全部待写入内容，报告标记取消；取消检查与同步事务之间不插入异步等待。提交开始后沿用 Vocabulary 的 `too_late` 语义，不把已提交数据误报为回滚。
- 批次超时停止剩余分析，已验证项可按 Vocabulary 模式提交，未完成项标记 TIMEOUT；区别于用户主动取消时放弃待写入内容。
- 报告包含逐项原输入、规范化短语、新增、已存在、批内重复、未识别、失败或取消状态及计数，条目标识使用 phrase，不伪造 Vocabulary 的 entryId。
- 业务提交成功但会话回复保存失败时，从持久化报告恢复反馈；未提交执行的重试先重新查重。错误保留内部 cause，在 Main 边界转换为国际化安全错误。

## 实施步骤

1. **Shared 与迁移**：新增 `src/shared/phrase.ts` 的输入、条目、报告及错误协议；按 skillId 扩展会话技能的参数和报告联合类型。追加迁移创建 phrase 表，更新技能 ID 与用量 operation 约束并保留历史记录。
2. **领域模块与仓储**：在 `src/core/learning/phrase/` 实现输入解析、分析器接口、批次模块、仓储接口和反馈接口；实现 SQLite 仓储及业务数据与报告的原子提交。Core 通过依赖注入访问仓储。
3. **工具与模型适配**：实现两个窄工具、严格响应校验、`src/core/llm/llm-phrase-analyzer.ts` 与 `src/core/prompt/phrase-analysis.ts`。复用模型及语言配置快照，用量登记为 `phrase_analysis`，同步扩展用量类型、约束和展示文案。
4. **会话与 Main**：新增 Phrase conversation skill，在 Main 装配；将执行、取消、报告持久化、重试恢复和反馈按 skillId 分派，避免通过类型断言把 Phrase 报告当作 Vocabulary 报告。
5. **Preload 与 Renderer**：复用业务化会话技能 API，扩展类型化请求；需要修改桥接时同步更新 `src/preload/index.ts` 与 `src/preload/index.d.ts`。接入 `/phrase` 直接输入及选择器路径、运行状态和逐项反馈；Renderer 不导入 Core，不暴露通用工具执行、SQL 或原始 IPC 接口。
6. **国际化**：补齐中英文指令名、说明、多行输入提示、处理阶段、结果、错误和无障碍文本，使用插值与复数规则。生成内容作为纯文本呈现，避免解释或例句中的 HTML 被执行。
7. **验证与收尾**：完成以下测试及手动验收后，将本计划状态更新为“已实施”。

## 验证与验收标准

- 输入测试：单项、多行、空行、短语内部逗号与空格、Unicode 规范化、大小写差异、长度及数量上限、批内重复；已有项跳过，全部已存在时零模型请求。
- 工具测试：合法插入和未识别；正文冒充工具、未知或多个工具、非法 JSON、额外 SQL 字段、短语替换、空字段、超长内容、截断、拒绝及不支持 tool call 均不产生非法写入。含引号、分号和 SQL 片段的合法文本始终作为绑定数据处理。
- 数据库测试：从当前版本升级、迁移重复运行、历史 Vocabulary/其他技能与用量记录保留、唯一约束、并发重复插入、事务回滚、报告失败回滚和 execution 重放幂等。
- 会话集成测试：受控模型为 `look forward to` 返回解释及例句后，恰好新增一行三个字段；再次提交跳过。覆盖混合成功、未识别、超时、取消、提交后取消和回复恢复，UI 状态及计数与数据库一致。
- Renderer 组件或 Playwright 测试：直接输入与选择器均可提交，支持多行短语参数；中英文文案完整，完成、失败和取消后退出运行状态；Vocabulary 及普通对话无回归。
- 测试放在模块 `__tests__/`，跨模块测试放在 `tests/integration/`，端到端测试放在 `tests/e2e/`。实施后运行相关测试、`pnpm lint`、`pnpm typecheck`、`pnpm build`，并通过 `pnpm dev` 手动验收。

## 实施结果记录

- 数据库迁移使用版本 9（计划编写时最新为 7，实施时已到 8）：创建 `phrase` 表，整表重建 `conversation_skill_executions`（skill_id CHECK 扩展为 vocabulary/phrase）与 `llm_request_usage`（operation 新增 phrase_analysis），历史行全部保留并带行数守卫。
- 通用会话技能接口位于 `src/core/conversation/conversation-skill.ts`；ConversationModule 以 skillId 注册表分派执行、反馈与重试恢复，报告判别使用 zod 守卫（isVocabularyBatch / isPhraseBatch），无类型断言。
- Phrase 工具协议位于 `src/core/tools/phrase-tools.ts`；固定 SQL 仅存在于 `src/database/sqlite-phrase-repository.ts`，仓储接口只接收内容对象。
- Composer 由 `<input>` 改为 `<textarea>`（Enter 发送、Shift+Enter 换行），支持多行短语；`/phrase` 支持直接输入与选择器两条提交路径。
- 顺带修复了三处先于本计划失效的 e2e 断言（行动数量 4→6、反馈省略空分组后的 '0 added' 期望），e2e 套件恢复全绿。
- 验证：vitest 758 项、Playwright e2e 26 项全部通过；`pnpm lint`、`pnpm typecheck`、`pnpm build` 通过；`pnpm dev` 启动后真实开发库成功升级到 v9 且历史数据（会话/消息/词条/用量）完整保留。
- Review 后简化：Phrase 批次强制传入 executionId，仅保留业务数据与报告原子提交；移除独立 saveBatch、请求 Map、BUSY/dispose 生命周期；取消改为单批次 AbortSignal。分析器工厂直接接收模块超时并创建一次配置快照，删除 Runtime 包装。模块及仓储测试统一走真实提交路径，删去重复 schema 与常量断言。
