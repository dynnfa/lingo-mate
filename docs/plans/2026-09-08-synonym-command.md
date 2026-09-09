# /synonym 近义词分组功能计划

- 日期：2026-09-08
- 状态：已实施

## 目标与范围

新增 `/synonym` 指令，接受以逗号分隔的多个单词，例如 `/synonym adequate, decent`。本地代码先跳过已经收录的单词，再由 LLM 调用工具查询近义词组、判断语义归属，并通过本地工具完成持久化。

需求中的 `synonym_grop` 按后文的 `synonym_group` 统一命名。首版新增 `synonym_group` 和 `synonym` 两张业务表，复用现有会话入口、模型配置、语言设置与执行状态机制。

LLM 只决定调用哪个工具及其参数。SQL、ID 生成、校验、事务、提交和回滚全部由本地代码负责；不提供执行任意 SQL 的工具，也不从模型正文中提取 SQL 执行。

## 当前代码基线

- `src/renderer/src/conversation/conversation-actions.ts`：已有斜杠行动列表和 `/vocabulary` 参数提取逻辑，需要新增 `/synonym` 入口。
- `src/shared/conversation.ts`、`src/core/conversation/conversation-skill-repository.ts`：技能调用及持久化类型需要从仅支持 vocabulary 扩展为按 `skillId` 区分的联合类型。
- `src/core/conversation/conversation-module.ts`：已有技能运行、阶段反馈、取消和重试入口，可接入 synonym 技能。
- `src/core/llm/llm-vocabulary-analyzer.ts`：已有工具响应校验，但只消费单次模型响应；本功能需要支持查询结果回传后的多轮工具调用。
- `src/database/migrations.ts`：当前迁移到版本 7；`conversation_skill_executions.skill_id` 限定为 vocabulary，LLM 用量表的 operation 也有 CHECK 约束，实施时需要一并迁移。

## 输入与去重规则

1. 支持直接输入 `/synonym adequate, decent`，也支持从斜杠选择器选中后补充参数；两条路径均进入类型化技能调用。
2. 接受英文逗号和中文逗号，去除首尾空白并忽略空片段。默认沿用现有词汇输入上限：总文本 4000 字符、最多 20 个词、单词最多 100 字符；空输入返回国际化错误。
3. 首版面向当前已支持的英语学习能力。单词采用 NFC、去首尾空白、连续空白归一并转小写的规范化规则，数据库 `word` 保存该规范值，原始输入保留在执行报告中。该规则仅用于 synonym，不改动现有 vocabulary 的大小写规则。
4. 本地先对本批输入去重，再批量查询 `synonym.word`。已有单词直接标记为跳过，不交给 LLM 重新分析或覆盖；全部存在时不调用 LLM。
5. 逐词串行处理剩余单词，让后续词能查询到本批刚创建的 group。输入在同一条指令中不代表一定属于同一组。
6. 首版按 word 唯一收录一个主要义项，已有 word 的其他义项也跳过，遵循本次需求的去重语义。多义项收录和多语言词库不在本次范围内。

## 数据模型

### synonym_group

| 字段    | 类型与约束          | 含义                                           |
| ------- | ------------------- | ---------------------------------------------- |
| id      | TEXT PRIMARY KEY    | 本地代码生成的 UUID                            |
| meaning | TEXT NOT NULL，非空 | 描述组内单词共有的语义，作为模型判断归组的依据 |

group 表示一个共同语义，不只是词列表。例如 adequate 和 decent 可以在“达到基本要求、尚可”这个义项下归为同组；不表示两词在所有语境中都可互换。

### synonym

| 字段        | 类型与约束                                | 含义                                                   |
| ----------- | ----------------------------------------- | ------------------------------------------------------ |
| id          | TEXT PRIMARY KEY                          | 本地代码生成的 UUID                                    |
| meaning     | TEXT NOT NULL，非空                       | 单词在当前 group 下的具体词义                          |
| word        | TEXT NOT NULL UNIQUE，非空                | 规范化后的单词，作为查重键                             |
| groupid     | TEXT NOT NULL，外键指向 synonym_group(id) | 所属近义词组                                           |
| distinction | TEXT NOT NULL，非空                       | 与共同语义及组内其他词相比的语气、程度、语域或使用区别 |

- 为 `synonym.groupid` 建索引，便于查询组内词条；开启并验证 SQLite 外键约束。
- 单词唯一性由数据库保证，避免仅靠调用前查重导致重复插入。
- 首个词的 distinction 描述其用法特点，不虚构尚不存在的组内成员。
- 两表的 meaning 与 distinction 使用本次执行的解释语言；查询返回已有文本供模型理解，不因界面语言切换重写历史数据。跨语言表述是否同义由模型判断，不能仅按 meaning 字符串相等判断。

## 工具协议与模型执行流程

工具定义放在 `src/core/tools/`，由 synonym 领域服务和注入的仓储执行；只向本次 synonym 执行暴露所需工具。所有参数使用严格 Zod schema 校验，拒绝未知字段、空内容、超长内容和当前待处理词之外的 word。

### 1. find_synonym_groups

- 参数：`word`、`meaning`、可选 `cursor`。
- 本地读取已有 group，返回 `{ groups: [{ id, meaning, words }], nextCursor }`；words 包含组内单词、词义及区别，返回内容有分页与长度上限。
- 首版遍历分页候选供 LLM 做语义判断，不以简单字符串匹配的空结果断言不存在近义组，也不引入向量数据库。
- 本地执行器记录当前词已查询的候选 ID 和分页进度。工具仅提供数据库中的事实，LLM 负责判断哪组符合当前义项。

### 2. add_synonym_to_group

- 参数：`word`、`meaning`、`groupid`、`distinction`。
- LLM 找到合适组时调用。执行器要求当前词已经调用查询工具，且 groupid 来自本次查询结果；仓储在事务内再次确认 group 存在。
- 本地事务中复查 word，不存在则插入 synonym；已存在则返回 `skipped_existing`，不覆盖已有词条。
- 返回已提交的词条及 group ID；成功状态只能来自真实提交结果。

### 3. create_synonym_group_and_add_word

- 参数：`groupMeaning`、`word`、`meaning`、`distinction`。
- LLM 查询全部候选且判断没有匹配组时调用。执行器检查该词的查询分页已完成，禁止未经查询直接创建组。
- 同一个本地事务内依次执行：复查 word → 新建 synonym_group → 将单词插入 synonym → 保存该词执行结果 → 提交。
- word 已存在时直接返回 `skipped_existing`，不创建 group。插入 synonym 或保存执行结果失败时整个事务回滚，不留下空 group。

### 4. report_unrecognized_word

- 参数：`word`。
- 无法识别为有效目标语言单词时调用，只记录未识别结果，不写两张业务表。

模型交互顺序为：本地预查重 → LLM 调用查询工具 → 本地查询并将 tool result 回传 → LLM 判断归组 → 调用已有组插入工具或新建组并插入工具 → 本地提交并返回结果。每词成功写入或报告未识别后结束，不依赖模型继续输出总结。

执行器保留工具调用 ID，将 assistant tool_calls 和相应 tool result 按协议加入后续模型请求。限制每轮一个工具调用，并设置每词总超时、工具轮数上限及候选扫描上限；达到上限则明确失败，不把未读完候选当作“没有合适组”。未知工具、非法参数、跳过查询直接写入、正文冒充工具结果均不执行写入。

Prompt 明确指定：word 使用目标学习语言；groupMeaning、meaning、distinction 使用解释语言；协议字段名和状态枚举保持固定。每次执行使用语言与模型配置快照。若已有 group 使用其他解释语言，要求按语义比较。

## 事务、并发、取消与恢复

- 原子单位为单词；新建组和首个词必须一起成功或一起回滚。整批允许部分成功，后续词失败不撤销已提交的词。
- 插入已有组时，synonym 写入与该词执行结果也在同一事务中完成。复用会话技能执行记录保存逐词报告，不额外创建第三张业务表。
- LLM 网络请求位于事务之外，不跨多轮模型调用持有 SQLite 事务。
- 首版在 Main 共享的 synonym 服务中串行调度批次，覆盖查询到提交的流程，避免两个本地批次基于同一份旧候选同时创建语义相同的组。数据库唯一约束兜底 word 重复；文本约束不能保证语义分组唯一，多进程协同和历史组自动合并不在本次范围内。
- 每次工具执行前和开启事务前检查取消信号；取消后停止后续模型和工具调用。已经提交的单词仍算成功，未处理单词标记取消，不误报整批回滚。
- 持久化逐词的新增、已存在、重复输入、未识别、失败和取消结果。会话反馈以本地报告为准，不采信模型自述的写入数量。
- 报告已提交但会话回复保存失败时，重试仅从报告恢复本地反馈。重新执行未完成项时先查重；不得重复创建组或插入词条。
- 模型不支持工具调用、超时、校验失败和存储失败均返回明确安全错误并退出运行状态，保留底层错误原因但不向 Renderer 暴露敏感内容。

## 实施步骤

1. **Shared 与数据库**：新增 synonym 输入、结果、错误码协议；扩展会话技能联合类型。追加数据库迁移创建两表、索引与约束，并重建受 CHECK 限制的技能执行表以接受 synonym；保留旧执行记录，按 skillId 校验各自参数与报告。
2. **领域服务与仓储**：在 `src/core/learning/synonym/` 实现解析、预查重、执行报告及仓储接口；在 `src/database/sqlite-synonym-repository.ts` 实现参数化 SQL 和每词事务，通过依赖注入连接 Core。
3. **工具与 LLM**：新增四个窄工具、调用顺序校验、多轮模型适配器和 `src/core/prompt/synonym-analysis.ts`。复用已有模型客户端与用量记录，每轮请求计入 `synonym_analysis`；同步扩展用量 operation 的类型、数据库约束及界面翻译。
4. **会话接入**：新增 synonym conversation skill，在 Main 装配共享服务，接入现有执行、取消、错误和恢复路径。复用业务化 Preload API；如需扩展接口，同步更新 `src/preload/index.ts` 和 `src/preload/index.d.ts`，不暴露原始 IPC、数据库或工具执行接口。
5. **Renderer 与国际化**：注册 `/synonym`，处理直接输入与选择器输入，展示处理中及逐词结果。新增指令说明、占位符、反馈、错误与无障碍标签的中英文翻译资源；业务规则留在 Core。
6. **验证与收尾**：完成下述测试及手动验收，通过后将本计划状态更新为“已实施”。

## 验证与验收标准

- 解析单元测试：中英文逗号、空输入、长度上限、空白及大小写规范化、本批重复词；已存在词跳过，全部存在时零模型调用。
- 工具与模型测试：查询后复用组、查询后新建组、分页继续查询、不同词义分组；伪造 groupid、错误 word、未经查询写入、未知工具、非法 JSON、工具不支持、超时和轮数上限均不产生非法写入。
- 数据库测试：从现有版本升级、旧技能和用量数据保留、迁移重复运行、word 唯一约束、外键校验、插入失败无空组、报告保存失败整体回滚、工具重放幂等。
- 会话集成测试：`adequate, decent` 在受控模型响应下只创建一个 group 和两条 synonym，后一个词可查询到新组；再次提交全部跳过；批次部分失败、取消及回复恢复准确反映已提交结果。
- Renderer 组件或 Playwright 测试：直接输入和选择器都能提交 `/synonym`，中英文文案完整，完成、失败、取消后退出运行状态；现有 `/vocabulary` 和普通对话不回归。
- 测试放在模块 `__tests__/`，跨模块测试放在 `tests/integration/`，端到端测试放在 `tests/e2e/`。实施后运行相关测试及 `pnpm lint`、`pnpm typecheck`、`pnpm build`，再用 `pnpm dev` 手动检查完整流程。

## 实施记录（2026-09-09）

- 基于实施时已有的 v9（含 `/phrase`）追加 v10，保留旧技能执行与用量记录；新增两张 synonym 业务表、外键、唯一约束与索引。
- 新增规范化输入、逐词报告、共享串行批次服务、四个受约束工具、多轮 LLM 适配器与双语本地反馈。复用已有类型化 Preload API，无新增高权限 Renderer 接口。
- 每词最长 60 秒、最多 52 轮工具响应；查询每页 5 组、最多 50 页，每组最多 100 词、单页 JSON 最多 60,000 字符。超限明确失败，不截断后据此创建组。
- 逐词事务同时保存词条与报告；取消和部分失败保留已提交词。排队中的批次可立即取消；回复保存失败重试仅恢复已持久化报告。逐词报告使用 `saved`、`existing`、`duplicate`、`unrecognized`、`failed`、`cancelled` 状态；工具已有词响应使用 `skipped_existing`。
- 用量页按现有聚合统计展示 `synonym_analysis`，同步扩展数据库 operation 约束与双语统计说明。

验证结果：

- `pnpm test`：67 个测试文件、796 项测试全部通过，覆盖输入、工具协议、多轮回传、迁移保留历史数据、事务回滚、幂等、并发串行、取消和回复恢复。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`：通过。构建仅有现有依赖的配置/注释警告。
- Electron：`synonym-import` 新用例通过，`phrase-import`、`vocabulary-import`、`message-lifecycle` 共 12 项回归通过。
- `pnpm dev`：在临时用户目录使用本地受控模型手动验证中文选择器、直接输入、逐词反馈、中文逗号与大小写去重；开发进程已停止。
- 迁移与写入验证使用临时数据库，未改动日常用户数据库。模型协议使用受控响应验证，未调用外部真实模型；实际语义归组质量仍取决于用户配置的模型。

### Review 修复（2026-09-09）

- 报告新增可选 `finalized` 标记，区分逐词检查点与最终报告；只有明确为最终报告才直接恢复本地回复。重试检查点时保留已新增、已存在和未识别结果，对未完成词重新查重并继续执行。旧报告缺少标记时按检查点恢复，无需数据库迁移。
- 预查重统一填入所有已存在词的结果，再进入模型处理；工具不支持时仅将尚待模型处理的词标记失败，不覆盖已存在词与本批重复词。
- 新增 3 项集成回归：预查重失败后继续执行、部分提交后的检查点恢复、工具不支持与已有词混合输入。原回复保存失败后零模型调用的恢复测试继续通过。
- `pnpm test`：67 个文件、799 项测试通过；`pnpm lint`、`pnpm typecheck`、`pnpm build` 通过。测试使用临时数据库和本地受控服务，本次未重跑 Electron 手动验收。

### 逻辑简化（2026-09-09）

- 三份领域同构的 `abortable-operation`（vocabulary、phrase、synonym）合并为 `src/core/learning/abortable-operation.ts` 的通用工厂，领域文件仅保留以错误类参数化的一行绑定，调用点签名不变。
- `conversation-actions.ts` 收敛为单一 `SKILL_COMMANDS` 元数据表，`/synonym` 等命令前缀与模式只维护一处，替换三处嵌套三元与散落的字面量。
- `SynonymModule.run` 改为接收已解析的输入项，消除对同一文本的重复解析。
- `synonymWordSchema` 复用 `SYNONYM_MAX_LENGTH` 常量，单词上限不再双写。
- 行为等价重构：`pnpm test` 68 个文件、802 项测试通过；`pnpm lint`、`pnpm typecheck` 通过。
