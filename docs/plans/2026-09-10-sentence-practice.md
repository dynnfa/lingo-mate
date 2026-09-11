# 造句练习实施计划

- 日期：2026-09-10
- 状态：已实施

## 目标与范围

在“开始练习”中新增“造句练习”菜单。每轮从 vocabulary 随机挑选 3 个单词，由 LLM 结合这 3 个单词生成 phrase（短语、搭配）提示；用户在 Textarea 中完成造句，提交后由 LLM 判断是否通顺、语法是否正确，并给出解释和修改建议。

首版约定：用户在同一份答案中使用全部 3 个单词，可以写一句或数句连贯的话；允许合理的时态、单复数等词形变化。提示用于帮助组织表达，不直接给出完整答案，也不要求用户照搬提示。phrase 提示由模型即时生成，不依赖已收藏的 phrase 数据。

练习会话、提示、答案和点评仅保存在内存，不新增练习历史、成绩持久化或词库写入。本次任务只产出计划，不实施功能。

## 当前代码基线

- `src/renderer/src/practice/PracticePage.tsx`：已有开始练习容器、词汇练习菜单、返回与 Escape 退出、焦点管理，可扩展菜单与详情区域。
- `src/renderer/src/practice/vocabulary/`：已有练习组件与状态 hook，可参考加载、提交、取消和错误展示交互。
- `src/core/learning/vocabulary/vocabulary-repository.ts`、`src/database/sqlite-vocabulary-repository.ts`：已有只读 `sampleRandom(count)`，可从完整词库随机抽取，无需新增数据库 schema。
- `src/core/learning/vocabulary-practice/`：已有词条快照、内存会话、超时和取消模式；新建造句领域服务，避免耦合现有释义审查规则。
- `src/main/vocabulary-practice-ipc.ts`、`src/shared/vocabulary-practice.ts`、`src/preload/index.ts`：可参考 IPC 校验、窄 API 与错误转换。
- `src/core/llm/llm-vocabulary-practice-reviewer.ts`、`src/core/prompt/`：可复用已有模型配置和客户端接入方式，提示生成与造句点评使用独立 Prompt 和输出协议。

## 页面与交互

在现有左侧菜单中新增“造句练习”，保留词汇练习及其默认选中行为。选择造句练习后自动开始一轮，右侧按以下顺序纵向排列：

```text
造句练习                              [换一组]

需要使用的单词
[word 1]    [word 2]    [word 3]

短语提示
• phrase / 搭配 — 含义或使用提示
• phrase / 搭配 — 含义或使用提示
• ……

你的句子
┌──────────────────────────────────────────┐
│ Textarea：使用上面的三个单词完成造句      │
│                                          │
└──────────────────────────────────────────┘
[提交点评]                                  [取消]

点评结果（提交成功后出现）
单词使用情况 / 通顺度 / 语法 / 修改建议
```

1. 先抽取并显示 3 个词，再加载中间提示；提示生成中显示加载状态，成功后启用提交。Textarea 是练习输入区最下方的控件，点评显示在其下方。
2. 每轮恰好抽取 3 个不同词条，不能来自 Renderer 首屏缓存，也不能让模型补造词条。词库为空或不足 3 个时显示实际数量与补充词汇提示，不发起模型调用。跨轮允许重复。
3. 默认生成 3–6 条简短搭配提示，整体覆盖全部 3 个词；可提供连接场景帮助组合表达，避免为了把三个词硬凑在一起而生成不自然搭配。
4. Textarea 提供可访问标签、占位说明；答案去除首尾空白后须为 1–2000 字符，前后端均校验。
5. 提交时固定答案快照，禁用修改与重复提交，显示审查状态并提供取消。成功后展示各项反馈与可选改写，不能仅以红绿色区分结果。
6. 修改答案后清除旧点评，允许再次提交。点评失败或取消保留单词、提示和答案，可重试；提示失败可对同一组单词重新生成。
7. “换一组”开启新轮次并清空旧提示、答案和点评；已有答案时通过国际化确认交互避免误清空。
8. 切换菜单、返回或退出页面时中止在途请求并释放会话。使用轮次和请求 ID 忽略迟到结果，确保旧提示或点评不会覆盖新一轮。
9. 保留现有 Escape 退出和焦点恢复行为；确认对话框打开时优先处理对话框的 Escape。支持窄窗口、长词和键盘操作。

## Core 与模型协议

### 会话与抽词

- 新增 `src/core/learning/sentence-practice/`，通过窄接口注入词库抽样和模型能力，负责抽词、会话快照、状态校验、生成提示和点评。
- 复用 `sampleRandom(3)`，校验返回词条数量与 ID 唯一性；Core 保留本轮词条及可空参考释义快照，Renderer 只接收展示需要的 ID 与单词。
- 不复用词汇练习的活动会话实例，避免两个练习菜单互相覆盖状态；复用取消等公共能力时按实际职责提取，避免无必要抽象。
- 会话固定解释语言与练习语言；解释语言来自用户语言设置，首版练习语言明确为英语。若实施时已有学习语言配置则读取该配置，不能用界面语言推断练习语言。

### 提示生成

- 输入：本轮三个词的 `entryId`、`term`、可空 `referenceMeaning`，以及显式的 `explanationLanguage`、`practiceLanguage`。
- 输出：`{ hints: [{ entryIds, phrase, explanation }] }`。`entryIds` 指向该提示关联的词，`phrase` 使用练习语言，`explanation` 使用解释语言。
- 使用 Zod 限制为 3–6 条、非空文本和长度上限；引用 ID 必须属于本轮，所有提示合计须覆盖三个词。Prompt 要求相关词以原形或合理变形实际出现在对应搭配中，不能仅靠挂接 ID 冒充覆盖。
- 模型只给短语、搭配与使用提示，不提前给出包含三个词的完整范文。参考释义缺失时依据通常词义生成，不回填词库。

### 答案点评

- Renderer 提交 `sessionId`、`requestId`、`answer`，Core 根据快照补齐单词与提示，禁止由 Renderer 替换目标词。
- 模型分别判断三词是否使用且用法正确、语句是否通顺、语法是否正确。词形变化由模型结合语境判断，不用简单字符串包含作为通过条件。
- 建议结构化输出：

```ts
interface SentenceReview {
  wordUsage: Array<{
    entryId: string
    used: boolean
    correct: boolean
    feedback: string
  }>
  fluency: { natural: boolean; feedback: string }
  grammar: {
    correct: boolean
    issues: Array<{ original: string; suggestion: string; explanation: string }>
  }
  summary: string
  revisedAnswer: string | null
}
```

- `wordUsage` 必须与三个词条一一对应；未使用的词不能判为用法正确。语法正确时 `issues` 为空，错误时须提供具体问题；有修改必要时提供保留原意且使用三个目标词的改写，无需修改时 `revisedAnswer` 为 null。
- `feedback`、`explanation`、`summary` 使用解释语言；`original`、`suggestion`、`revisedAnswer` 使用练习语言。两次实际发送的 Prompt 均显式指定各字段语言，字段名与枚举保持稳定。
- 静态 UI 展示三项独立判断，不增加分数系统；若展示总体通过，仅在全部词正确使用、通顺且语法正确时成立。
- 不要求模型执行 UI 工具。模型结果经过 schema、ID 对应和一致性校验后，由 React 按固定布局以文本展示；不执行 HTML、脚本或模型提供的样式。
- 词条、提示和答案作为不可信数据嵌入请求，不能覆盖系统指令。非法 JSON、空响应、截断和自相矛盾结果按无效分析处理，不显示为成功。

### 生命周期与失败处理

- 状态覆盖抽词中、提示生成中、可作答、点评中、完成、失败、取消；同一会话禁止并发生成与点评。
- 提示和点评分别设置总超时（首版各 120 秒）并传递 AbortSignal，取消后停止后续处理，不做无限自动重试。
- 模型未配置、凭据不可用、网络失败、超时、无效结果与词库读取失败，转换为明确、安全且可国际化的错误码；不向 Renderer 或日志泄露凭据、学习记忆或原始异常。

## 实施步骤

### 1. Shared 协议与领域服务

- 新增 `src/shared/sentence-practice.ts`，集中定义输入输出 schema、长度约束、会话展示类型、提示、点评、错误码及 IPC channel。
- 新增造句练习服务及模型接口，实现固定三词抽样、快照、提示生成、答案点评、超时、取消和释放。
- 仓储保持只读；复用已有随机抽样实现，不新增迁移。

### 2. LLM 适配与 Prompt

- 在 `src/core/prompt/` 新增提示生成和答案点评模板，在 `src/core/llm/` 新增对应适配器。
- 复用已有模型配置、凭据读取与客户端能力，不新增提供商或设置页面；使用当前客户端支持的结构化返回方式，并在本地严格校验。
- 自动化验证注入假模型，不依赖真实 API 或用户凭据。

### 3. Main 与 Preload

- 新增 `src/main/sentence-practice-ipc.ts`，提供 `sentence-practice:start`、`hints`、`review`、`cancel`、`close` 的集中 channel 常量及处理器。
- `start` 只抽词并返回会话；`hints` 对该会话生成或重试提示；`review` 提交答案；`cancel` 按会话与请求 ID 中止调用但保留可重试状态；`close` 中止调用并释放会话，保持幂等。
- 校验可信窗口、主 frame、输入输出、会话归属与当前请求；窗口销毁时清理资源。
- 同步更新 `src/preload/index.ts`、`src/preload/index.d.ts` 和应用 API 类型，暴露 `window.api.sentencePractice` 窄接口。Renderer 不直接访问 Electron、Core、数据库或 Node.js。
- 首版两次模型调用均完成后一次返回结果，无需新增流式事件协议。

### 4. Renderer 与国际化

- 扩展 `PracticePage` 菜单与条件渲染；新增 `src/renderer/src/practice/sentence/SentencePracticeDetail.tsx`、状态 hook 和必要辅助函数。
- 实现顶部词卡、中间提示、底部 Textarea、提交点评、取消、换组、错误重试与点评结果区。
- 在 `src/renderer/src/i18n/locales/en/common.json` 与 `zh-CN/common.json` 同步增加菜单、文案、空状态和无障碍标签；安全错误按现有错误资源组织方式补充双语翻译。
- 动态数量与文字使用 i18n 插值；menu 专属组件、hooks 和测试统一归入 `practice/sentence/`。

## 验证与验收

- Core / 仓储：恰好三词、不重复、空词库、不足三词不调用模型、参考释义为空、快照不随词库变化、无效会话、超长或空答案、并发请求和取消后重试。
- Prompt / LLM：两次请求显式包含语言规则；提示覆盖三个目标词；点评覆盖漏用、正确词形变化、用词错误、通顺但语法错误、语法正确但不自然、全部正确；拒绝未知或重复 ID、非法 JSON、矛盾结果、截断和空输出；超时取消正常收敛。
- Main / Preload：可信来源、窄 API、输入输出校验、归属隔离、请求取消和幂等释放。
- Renderer：菜单切换、三层布局、提示加载、Textarea 校验、提交、三个维度点评、编辑清除旧结果、换组确认、取消与失败保留答案、忽略迟到响应、中英文与键盘可访问性；现有词汇练习不回归。
- Electron E2E：使用临时用户目录和假模型完成“开始练习 → 造句练习 → 随机三词 → phrase 提示 → 输入 → 提交点评 → 修改重试”，验证退出中止请求。
- 单元与组件测试放在被测模块的 `__tests__/*.test.ts(x)`；跨模块测试放在 `tests/integration/`，端到端测试放在 `tests/e2e/`。

实施完成后运行相关测试及：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:electron
```

验收标准：用户可从开始练习进入造句练习，看到 vocabulary 的三个随机单词、LLM 生成的相关短语提示及下方 Textarea；提交后得到单词使用情况、通顺度和语法点评，失败或取消不会卡住页面。

若实施范围扩展到数据库迁移或用户持久化数据变更，须按项目约定先询问用户，再决定是否执行。全部实现及相关验证完成后，将本计划状态更新为“已实施”。
