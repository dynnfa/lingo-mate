# Recorded Vocabulary 新增 Phrase 菜单与表格删除计划

- 日期：2026-09-09
- 状态：待实施

## 目标与范围

在 Recorded vocabulary 页面左侧新增与 Vocabulary 并列的 Phrase 菜单。点击后，右侧详情区域以 table 展示已收藏短语，最右侧操作列支持删除单行数据。

“详情页”指菜单对应的右侧内容区，不新增单条短语的独立路由。首版包含菜单切换、分页列表、单条删除及必要的加载和错误状态；不包含编辑、搜索、批量删除或新的模型分析流程。

## 当前基线与关联计划

- `src/renderer/src/recorded/RecordedPage.tsx` 当前只有默认选中的 Vocabulary 菜单，右侧详情容器为空，已有返回、Escape 退出和焦点管理。
- `docs/plans/2026-09-09-recorded-vocabulary-detail.md` 是独立的 Vocabulary 详情计划，目前状态为待实施。本计划不假设该功能已完成；后续若已有表格或确认框实现，可复用适合的基础组件和样式。
- `src/shared/phrase.ts` 已定义 `PhraseEntry`，字段为 `phrase`、`explantation`、`example`。保留协议中的 `explantation` 拼写，界面显示正常的“解释”标签。
- `src/database/migrations.ts` 中的 `phrase` 表使用短语文本作为主键，没有独立 ID 或创建时间。
- `PhraseRepository` 与 `SqlitePhraseRepository` 当前提供收录查询和批次保存，尚无列表分页和删除能力。
- Main 已创建短语仓储；Preload 尚未提供短语列表、删除 API，`LingoMateApi` 定义于 `src/shared/conversation.ts`。

## 页面与交互

1. 保持进入页面默认选中 Vocabulary，新增 Phrase 菜单及选中态；点击 Phrase 后显示对应标题和表格。菜单使用可键盘操作的按钮，并更新 `aria-current`。
2. 使用语义化 `table`、`thead`、`tbody`，列顺序如下：

   | 列   | 数据来源               | 展示方式                 |
   | ---- | ---------------------- | ------------------------ |
   | 短语 | `phrase`               | 完整展示，支持长文本换行 |
   | 解释 | `explantation`         | 保留换行，自动换行       |
   | 例句 | `example`              | 保留换行，自动换行       |
   | 操作 | 当前行的 `phrase` 主键 | 删除按钮，始终位于最右侧 |

3. 不增加当前数据不存在的音标或记录时间列；收藏内容按保存原文展示，不发起 LLM 调用。
4. 表格容器支持横向滚动，操作列使用右侧 sticky 定位和独立背景，适配现有主题及较窄窗口。
5. 每页默认读取 50 条，最多 100 条；按 `phrase COLLATE BINARY ASC` 稳定排序，以最后一条短语文本作为游标，提供“加载更多”。排序和游标比较必须使用相同规则。
6. 提供首屏加载、空状态、读取失败及重试；加载更多失败时保留已有行，在底部提示并允许重试。
7. 离开 Phrase 时清理本地视图状态，重新进入时读取最新列表；忽略上一次视图的迟到请求结果，避免快速切换菜单后显示错误数据。

### 删除单行

1. 点击删除，显示包含短语名称的确认对话框，提供取消和确认删除。确认前不修改数据。
2. 通过当前行返回的完整 `phrase` 主键精确删除；不得使用模糊匹配、大小写转换或新增规范化逻辑改变目标。
3. 确认后禁用重复提交，显示删除中状态。成功后再移除该行；失败保留原行并显示可重试的安全错误提示。
4. 目标已不存在时返回 `deleted: false`，按幂等成功处理并移除过期行。
5. 仅删除 `phrase` 表中的目标记录，保留历史会话消息和收录批次报告。
6. 删除后保留分页游标；分页使用值比较，不依赖游标行仍存在。已加载行全部删除但仍有后续游标时保留“加载更多”，仅在没有行且没有下一页时显示空状态。
7. 同一视图内记录已删除的主键，过滤并发列表请求的迟到结果，防止旧数据重新出现；重新进入视图时重置该集合，以便重新收录的短语可正常显示。
8. 确认框打开时 Escape 只关闭对话框，不触发页面退出。取消后焦点返回原按钮，删除成功后移至相邻行操作或详情标题；状态变化提供可访问通知。

## 实施步骤

### 1. Shared 协议

- 在 `src/shared/phrase.ts` 新增集中定义的 `PHRASE_CHANNELS`，使用 `phrase:list`、`phrase:delete`。
- 定义严格的列表输入 schema（可选 `limit`、`cursor`）和分页结果 schema（`entries`、可选 `nextCursor`），复用 `PhraseEntry`。
- 删除输入为 `{ phrase: string }`，限制非空及最大长度，但不转换主键值；成功返回目标 `phrase` 与 `deleted: boolean`。
- 列表和删除响应采用 `status: 'ok' | 'error'` 判别联合，错误只暴露安全错误码。类型与 schema 放在 Shared，不从 Renderer 导入 Core。
- 扩展 `LingoMateApi`，增加 `window.api.phrase.list(input)` 和 `window.api.phrase.delete({ phrase })`。

### 2. Core 与 Database

- 为 `PhraseRepository` 增加列表分页和按主键删除接口，同步更新测试替身。
- 在 Core 提供短语管理服务，通过仓储依赖完成列表与删除及输入约束，不改变现有短语收录流程。
- SQLite 使用参数化查询；列表读取 `limit + 1` 条判断下一页，删除使用 `DELETE FROM phrase WHERE phrase = ?`，以受影响行数返回是否删除。
- 沿用存储错误封装，在错误产生处保留原始原因。
- 复用现有表及主键，不计划数据库迁移。按照项目 `AGENTS.md`，若实施中需要执行迁移或修改用户真实持久化数据，必须先询问用户；验证使用临时数据库。产品内的单行删除由用户在确认框中授权。

### 3. Main 与 Preload

- 新增 `src/main/phrase-ipc.ts`，参考现有 `usage-ipc.ts` 校验可信窗口、主 frame、URL 和输入输出 schema。
- 在 `src/main/index.ts` 复用现有短语仓储并注入管理服务，注册及清理 handler。
- 进程边界转换为安全错误，不向 Renderer 传递 SQL、路径、异常堆栈或其他内部信息。
- 更新 `src/preload/index.ts` 的窄接口与输入输出校验，同步核对 `src/preload/index.d.ts` 的类型声明。

### 4. Renderer 与国际化

- 为 `RecordedPage.tsx` 增加菜单选中状态，按选中项渲染详情，保留现有页面返回及焦点恢复行为。
- 新增 `src/renderer/src/recorded/PhraseDetail.tsx`，实现表格、分页、删除确认与请求生命周期管理；按实际复杂度提取局部 hook。
- 在 `src/renderer/src/assets/main.css` 增加或复用表格、滚动、操作列和状态样式，避免为两个菜单引入不必要的通用框架。
- 同步更新 `src/renderer/src/i18n/locales/zh-CN/common.json` 和 `en/common.json`：菜单、标题、表头、空状态、重试、分页、确认、删除中、错误及无障碍文案全部使用翻译 key，短语名称使用插值。

## 验证与验收

- Shared：分页边界、非法游标、非法删除主键、多余字段、成功与错误响应校验。
- Core / Database：稳定排序、多页无重复遗漏、精确删除单条、相似短语不受影响、删除不存在记录幂等、删除游标行后继续分页、存储失败，以及历史消息和批次报告保持不变。
- Main / Preload：可信来源校验、拒绝子 frame 和非法来源、输入输出校验、安全错误转换与窄接口桥接。
- Renderer：菜单切换、真实表格与列顺序、长文本、加载/空/失败/重试、分页、删除取消/成功/失败/重复点击、最后一行删除、迟到请求、Escape 和焦点行为、中英文文案。
- E2E：使用临时用户目录和数据库，验证“打开 Recorded vocabulary → 点击 Phrase → 查看表格 → 取消删除 → 确认删除 → 重新进入或重启后验证结果”，并回归 Vocabulary 菜单和页面退出；不依赖外部模型。
- 单元与组件测试放在模块下的 `__tests__/`，采用 `*.test.ts` / `*.test.tsx`；跨模块测试放在 `tests/integration/`，端到端测试放在 `tests/e2e/`。

实施完成后运行：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:electron
```

验收标准：Phrase 菜单可切换并读取真实收藏数据，详情以表格展示；最右侧可确认删除单行，失败不丢数据，删除结果持久化；分页、菜单切换、中英文和键盘操作通过验证。全部计划工作及相关验证完成后，将本计划状态更新为“已实施”。
