# Recorded Vocabulary 详情页与单词删除计划

- 日期：2026-09-09
- 状态：已实施

## 目标与范围

为已记录（Recorded）页面下的 Vocabulary 菜单补充右侧详情页，以 table 展示已收藏的单词及其内容，最右侧固定为操作列，支持删除单条词汇记录。

这里的“详情页”指 Vocabulary 菜单对应的内容区域，不新增逐词跳转的独立页面。首版包含列表读取、分页加载、单条删除、加载与错误状态；搜索、编辑、批量删除和其他学习内容菜单不在本次范围内。

## 当前代码基线

- `src/renderer/src/recorded/RecordedPage.tsx`：已有左侧 Vocabulary 菜单并默认选中，右侧 `recorded-detail` 为空；已有返回、Escape 退出和焦点管理。
- `src/shared/vocabulary.ts`：已有 `VocabularyEntry`、列表输入与游标 schema；词汇字段包含单词、音标、释义、概念说明、例句和创建时间，历史记录允许内容字段为 null。
- `src/core/learning/vocabulary/vocabulary-repository.ts`：已有 `list` 接口，没有单条删除接口；`VocabularyPage` 目前定义在 Core。
- `src/database/sqlite-vocabulary-repository.ts`：已有按 `created_at DESC, id DESC` 排序的游标分页查询，默认每次 50 条、最多 100 条。
- `src/preload/index.ts`：尚未暴露词汇列表与删除 API；`LingoMateApi` 定义于 `src/shared/conversation.ts`。
- `src/main/usage-ipc.ts`：可参考其可信窗口和主 frame 校验、输入输出校验、安全错误转换与 handler 清理模式。

## 页面与交互

1. 进入 Recorded 页面，默认展示 Vocabulary 详情；菜单与现有左右分栏布局保持一致。
2. 详情区包含标题、表格和底部“加载更多”按钮；首次读取 50 条，按已有游标继续追加，直到没有 `nextCursor`。
3. 使用语义化 `table`、`thead`、`tbody` 和列标题，按以下顺序展示：

   | 列 | 数据来源 | 展示规则 |
   | --- | --- | --- |
   | 单词 | `term` | 完整展示并允许长词换行 |
   | 音标 | `phonetic` | null 显示统一的缺失内容占位 |
   | 释义 | `meaning` | 保留换行，长文本自动换行 |
   | 概念说明 | `concept` | 保留换行，长文本自动换行 |
   | 例句 | `exampleSentences` | 每条例句独立展示，null 使用占位 |
   | 记录时间 | `createdAt` | 根据当前界面语言和本地时区格式化 |
   | 操作 | 当前记录的 `id` | 提供“删除”按钮，始终位于最右侧 |

4. 表格容器支持横向滚动；操作列使用右侧 sticky 定位与独立背景，使长内容下删除入口仍可见。
5. 首屏加载、空词库、读取失败分别展示对应状态；失败可重试。加载更多时保留已有行，失败在底部提示并允许重试。
6. 不展示数据库内部的模型与 Prompt 元数据，不发起 LLM 调用；已保存的自然语言内容按原文显示。

### 单词删除

1. 点击某行“删除”，打开带单词名称的确认对话框，说明将删除该收藏记录，提供取消与确认删除。
2. 确认后通过该行的唯一 `id` 删除一条记录，不按 `term` 删除，避免误删历史同名单词。
3. 删除期间禁用重复提交并展示进行中状态；请求成功后再移除对应行。失败保留原行与安全错误提示，允许重试。
4. 删除不存在的 ID 返回成功且 `deleted: false`，页面移除过期行，保证重复请求幂等。
5. 仅删除 vocabulary 记录，不改写历史会话消息和收藏批次报告；这些报告表达历史执行结果。
6. 删除后保留现有分页游标；游标按字段值比较，不依赖游标行仍存在。已加载行全部删除但仍有后续游标时，继续提供加载更多；只有没有行且没有后续游标时才显示空词库。
7. 删除对话框打开时，Escape 只关闭对话框，不能冒泡触发 Recorded 页面退出；关闭后恢复合理焦点，成功删除后移至相邻行操作或详情标题。
8. 页面重新进入时读取最新数据；读取与删除交错时忽略已删除 ID 的迟到列表结果，页面卸载或重置后忽略旧请求结果，避免词条重新出现。

## 实施步骤

### 1. 定义 Shared 协议

- 在 `src/shared/vocabulary.ts` 集中新增 `VOCABULARY_CHANNELS`，使用 `vocabulary:list`、`vocabulary:delete`。
- 将分页结果类型与 schema 放入 Shared，Core 复用，避免 Renderer 导入 Core。
- 列表复用 `listVocabularyInputSchema`，结果使用 `status: 'ok' | 'error'` 判别联合，成功时包含 `entries` 和可选 `nextCursor`。
- 删除输入限定为 `{ id: UUID }`；成功结果包含 `id` 与 `deleted: boolean`，错误结果只携带安全错误码。
- 扩展 `LingoMateApi`，提供 `window.api.vocabulary.list(input)` 与 `window.api.vocabulary.delete({ id })`，不暴露任意 SQL 或 IPC channel。

### 2. 补齐 Core 与数据库能力

- 为 `VocabularyRepository` 增加 `deleteById(id): boolean`，同步更新测试替身。
- 新增轻量词汇管理服务，通过仓储依赖提供列表与删除，负责领域输入约束；不修改现有收藏分析流程。
- SQLite 使用参数化 `DELETE FROM vocabulary WHERE id = ?`，根据受影响行数返回结果，沿用存储错误封装并保留原始原因。
- 复用现有表、字段与索引，预计无需 schema 迁移。
- 根据项目 `AGENTS.md` 的持久化变更约定，实施中若要操作用户真实数据库或执行迁移，应先询问用户；自动化验证使用临时数据库。产品内的删除确认负责授权用户选中的那条记录。

### 3. 接入 Main 与 Preload

- 新增 `src/main/vocabulary-ipc.ts` 注册列表和删除 handler，校验可信窗口、主 frame、URL 与 Zod 输入。
- 在 `src/main/index.ts` 复用已有词汇仓储并注入管理服务，按现有生命周期注册和清理 handler。
- Main 对输出执行 schema 校验，将异常转换为安全错误码，不向 Renderer 传递数据库路径、SQL、异常堆栈或其他内部内容。
- 更新 `src/preload/index.ts`，对输入和返回值校验；同步核对 `src/preload/index.d.ts` 的 `window.api` 类型声明与新增接口保持一致。

### 4. 实现表格详情区

- 在 `src/renderer/src/recorded/` 新增 `VocabularyDetail.tsx`，由 `RecordedPage` 渲染，页面状态与请求逻辑按复杂度提取为局部 hook。
- 在 `src/renderer/src/assets/main.css` 添加表格、滚动容器、操作列、状态区和删除确认样式，适配现有主题与窗口尺寸。
- 使用真实表格和键盘可操作按钮；提供 caption 或可访问名称、列标题关联、删除按钮对应词汇的可访问名称和状态通知。
- 在 `src/renderer/src/i18n/locales/zh-CN/common.json` 与 `en/common.json` 同步增加标题、表头、占位、分页、确认、进行中、空状态和错误等翻译 key；动态词汇使用插值。
- 保持现有页面返回、焦点恢复、会话与草稿保留行为。实施时注意工作区已有的 App、样式和语言资源改动，避免覆盖。

### 5. 验证与验收

- Shared 测试：拒绝无效 UUID、非法分页参数和多余字段，校验成功与错误结果。
- Core / Database 测试：按 ID 只删除一条、同名单词互不影响、不存在 ID 幂等、存储失败、列表排序、游标行删除后仍可继续分页，以及历史 null 内容可读取；验证历史会话和批次报告不变。
- Main / Preload 测试：可信来源、子 frame 与非法来源拒绝、输入输出校验、安全错误映射和窄接口桥接。
- Renderer 组件测试：真实表格与操作列顺序、数据和空值展示、加载/空/失败/重试、分页、删除取消/成功/失败/重复点击、最后一行删除、迟到请求、对话框 Escape 与焦点行为。
- Electron 端到端测试放在 `tests/e2e/`，使用临时用户目录与词汇数据验证“进入 Recorded → 查看表格 → 取消删除 → 确认删除 → 再次进入或重启后记录不再出现”；不依赖外部模型。
- 单元和组件测试放在对应模块的 `__tests__/`，命名为 `*.test.ts` / `*.test.tsx`；跨模块测试放在 `tests/integration/`。

实施完成后运行：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:electron
```

验收要求：Vocabulary 菜单打开后可读取真实收藏词汇并以表格展示；最右侧操作列可确认删除单词，失败不丢行，删除结果持久化；分页、中英文、键盘交互和已有页面导航通过验证。完成全部工作和验证后，将本计划状态更新为“已实施”。
