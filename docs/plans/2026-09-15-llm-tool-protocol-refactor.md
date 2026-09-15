# LLM 工具请求兼容策略与单次响应协议收敛计划

- 日期：2026-09-15
- 状态：已实施
- 关联：`docs/architecture-review-2026-09-11.html` 第三点、`docs/architecture-todo.md` P2「LLM 多模型兼容与可靠性」
- 决策：采用复核后的局部收敛方案，明确不实现原报告的通用 `runToolLoop`，不以 `maxRounds: 1` 包装单次调用。

## 目标与范围

集中当前重复的供应商工具请求参数策略，并为 vocabulary / phrase 提取单次工具响应的公共解析逻辑。让供应商规则与协议检查各有一个维护位置，同时保留各领域的完成条件、恢复策略和错误语义。

本计划不引入通用 Agent 框架、工具执行器注册表、循环策略 hooks 或统一领域错误工厂；不修改数据库、持久化协议、Main / Preload / Renderer 接口，也不调整请求重试、用量统计和超时预算。完成本计划仅覆盖关联 P2 的部分参数策略收敛，不代表多模型兼容事项全部完成。

## 当前事实与设计依据

| 调用方 | 当前行为 | 本次处理 |
| --- | --- | --- |
| `llm-vocabulary-analyzer.ts` | 一次请求，恰好一个工具调用，无正文；解析后返回词汇领域结果 | 接入公共请求策略和单次响应解析 |
| `llm-phrase-analyzer.ts` | 与 vocabulary 同构，返回短语领域结果 | 接入相同公共能力 |
| `llm-synonym-analyzer.ts` | 最多 52 轮，每轮单工具，executor 决定终态；Gemini 多调用允许一次整轮纠正 | 仅接入公共请求参数策略，保留循环 |
| `llm-vocabulary-practice-reviewer.ts` | 最多 8 轮，允许多个工具调用；文本 JSON 与累计标记一致才完成，包含独立纠错预算 | 仅接入公共请求参数策略，保留循环 |
| `llm-sentence-practice-completion.ts` | 无工具的单次 JSON 完成，已被造句功能复用 | 不纳入工具协议重构 |

真正的多轮循环只有两个，且结束条件、工具失败处理与纠错行为不同。将它们统一需要把这些规则暴露为配置和回调，增加调用者需要理解的内容。

vocabulary / phrase 已共用 `tool-protocol.ts` 的响应 schema 和工具能力错误识别，但仍重复响应语义检查、参数 JSON 解析及 DeepSeek 参数判断。synonym / vocabulary-practice 中的完整响应 schema 有实际差异，不能直接换成当前单次响应 schema：多轮回放需要保留 call id 和 reasoning 字段。

## 设计

### 1. 集中工具请求兼容策略

新增 `src/core/llm/tool-request-policy.ts`，作为纯函数模块，根据模型连接信息和调用方的明确请求意图生成工具相关参数。输入仅包含所需的 `protocol`、`baseUrl`、`modelId` 等字段，不需要 API Key。

调用方表达两个现有意图：

- 单次工具结果：vocabulary / phrase 使用。
- 多轮工具交互：synonym / vocabulary-practice 使用。

首版只搬迁已有参数规则，不建立通用能力注册表，不因集中策略而扩大某条规则的适用范围。

| 现有规则 | 收敛后的约束 |
| --- | --- |
| 四个调用方使用 `tool_choice: 'auto'` | 由公共策略生成 |
| vocabulary / phrase 对指定 DeepSeek hostname 和 `deepseek-v4-` 前缀设置 thinking 与 reasoning effort | 保留当前匹配条件和单次调用适用范围，不自动应用到另两个调用方 |
| synonym / vocabulary-practice 在非 Gemini 时设置 `parallel_tool_calls: false` | 保留当前范围，Gemini 继续省略 |
| vocabulary / phrase 不设置 `parallel_tool_calls` | 保留省略行为，避免借重构改变请求 |

函数只返回请求参数，不发请求、不读配置存储、不改消息、不执行工具。业务分析器移除重复的供应商参数判断；Gemini transport 继续负责原生协议转换和回放信息维护。

synonym 中“整轮拒绝多个工具并允许一次纠正”涉及执行前检查和领域流程，仍留在该分析器中。不能因为它包含 Gemini 判断就机械移入参数策略模块。

### 2. 收敛单次工具响应解析

在现有 `src/core/llm/tool-protocol.ts` 中添加具名纯解析函数，供 vocabulary / phrase 使用。它接收原始响应，返回工具名与解析后的 `unknown` 参数，或带内部原因的明确解析失败结果。

公共实现承担：

1. 响应基础结构检查，并沿用读取首个 choice 的行为。
2. `finish_reason` 必须为 `tool_calls`。
3. 拒绝非空 refusal 和非空正文；保留当前空字符串、null 与缺省字段的接受规则。
4. 必须恰好一个 function 工具调用。
5. 工具 arguments 必须为合法 JSON，解析值保持 `unknown`，交由领域校验。

该函数不发起 `complete` 请求，不接收 executor 或领域回调，不返回消息转录，不负责终态循环或超时。

各领域分析器继续负责 Prompt 和输出语言、请求上下文、允许的工具名、参数 schema、输入词条一致性、`unrecognized` 分支、结果构造、模型与 Prompt 版本，以及本领域异常转换。已有 abortable operation 和每请求用量归属保留原位。

#### 错误兼容

实施前用测试固定现有分类。当前单次分析器中，基础 schema 的 `.parse()` 异常会落入 `MODEL_ERROR`；语义检查失败和 arguments JSON 无效则为 `INVALID_ANALYSIS`。公共解析结果需要区分这两类失败，保持现有对外错误码及内部 cause，避免无意改变错误契约。

`isUnsupportedToolCall` 的识别范围保持现状，鉴权、限流、网络及无关 400 仍沿用既有分类。本计划不借机合并各领域 catch。

### 3. 保留多轮协议的独立性

synonym / vocabulary-practice 保留自己的响应约束、call id 检查、消息回放、工具参数失败策略和完成条件。

本轮不额外抽取共享多轮 schema。后续若需要统一协议字段，可以提取单个 tool-call 的基础 schema，再由调用方组合；必须保留多轮必需的非空 id 和 reasoning 字段，不能用单次 schema 替代。该后续方向不作为本计划验收前提。

## 实施步骤

### 1. 固定当前行为

- [x] 重新核对四个工具请求入口、当前分支改动及相关测试。
- [x] 为现有参数组合补充行为测试：匹配与不匹配的 DeepSeek 配置、Gemini、其他 OpenAI-compatible 配置，以及两类请求意图。
- [x] 固定单次响应的结构失败、语义失败、JSON 失败及对应领域错误码。
- [x] 确认测试使用模拟响应，无需真实模型调用或凭据。

### 2. 提取请求策略并迁移四个调用方

- [x] 新增 `tool-request-policy.ts` 及 `src/core/llm/__tests__/tool-request-policy.test.ts`。
- [x] 移除 vocabulary / phrase 中重复的 DeepSeek 参数判断。
- [x] 移除两个多轮分析器中重复的 `parallel_tool_calls` 参数分支。
- [x] 验证迁移前后各配置实际传入 `client.complete` 的参数一致，调用次数与 operation 不变。

### 3. 提取单次响应解析并迁移两个调用方

- [x] 在 `tool-protocol.ts` 增加单次响应解析函数及明确的解析结果类型。
- [x] 新增 `src/core/llm/__tests__/tool-protocol.test.ts`，直接验证协议行为。
- [x] vocabulary / phrase 接入公共解析，删除重复协议检查与 JSON 解析。
- [x] 保留两者的领域参数校验、结果和错误转换；不引入通用 analyzer 工厂或错误工厂。
- [x] 保留分析器契约测试，避免测试仅覆盖公共函数而漏掉接线错误。

### 4. 回归并更新文档

- [x] 验证两个多轮流程的完成条件、纠错上限、回放和执行顺序未改变。
- [x] 完成下述验证命令。
- [x] 在原架构报告第三点记录复核结论和本计划链接：两个多轮循环、两个单次调用，废弃通用 `runToolLoop` 建议；不把其完整响应 schema 描述成可直接互换。
- [x] 在关联 todo 记录本次实际完成的参数策略范围，其余能力验证、重试和错误分类工作继续待办。
- [x] 全部实施和验证完成后，将本文状态更新为“已实施”。

## 验收与测试

### 请求策略

- 精确 hostname / model 前缀匹配和非匹配情形均有覆盖，其他配置不被附加 DeepSeek 参数。
- Gemini 的多轮请求省略 `parallel_tool_calls`；其他协议保留 false；单次请求继续省略。
- 单次 DeepSeek 参数不会自动扩散到多轮请求；普通文本与造句 JSON 请求不受影响。

### 单次响应

- 有效 insert 与 unrecognized 的领域结果保持一致。
- 缺失或空 choices、错误字段类型、非 function 调用、异常 finish reason、refusal、非空正文、零个或多个调用和非法 JSON 均按约定失败。
- 未知工具、合法 JSON 但领域结构无效、词条不匹配继续由领域拒绝。
- 取消、超时、工具不支持及一般模型错误保持现有分类；无文本回退和额外模型请求。
- Prompt 的显式输出语言及原有 modelId、promptVersion、operation 保持正确。

### 多轮回归

- synonym：重复 id 被拒绝；Gemini 多工具整轮执行次数为零且只允许一次纠正；terminal 和 ROUND_LIMIT 保持原行为。
- vocabulary-practice：多工具结果关联正确；安全工具错误允许反馈纠正；最终文本与 marks 一致性检查及纠错预算保持原行为。
- assistant/tool 消息配对、reasoning 字段以及 Gemini 原始 parts 回放继续通过既有测试。

### 验证命令

```bash
pnpm exec vitest run src/core/llm/__tests__ src/core/tools/__tests__
pnpm lint
pnpm typecheck
pnpm build
```

新增测试统一放在对应 `__tests__/` 内。实现不应新增用户文案；若实际改动涉及文案，必须同步全部语言资源。任何后续需要的数据库或持久化变更均超出本计划范围，应按项目约定先询问用户。

## 完成标准

1. 四个工具调用入口复用明确的请求参数策略，实际请求行为保持一致。
2. vocabulary / phrase 共享单次响应协议检查，领域规则仍可在各自分析器直接阅读和验证。
3. 两个多轮状态机保留独立实现；没有新增 `runToolLoop`、`maxRounds: 1` 包装或可配置循环框架。
4. 类型、错误原因、取消、超时、用量归属和多轮回放均通过相关验证。
5. 文档如实记录实施范围及原报告建议的修订。
