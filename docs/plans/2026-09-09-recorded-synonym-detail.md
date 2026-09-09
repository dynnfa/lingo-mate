# Recorded Vocabulary：Synonym 菜单与分组表格计划

- 日期：2026-09-09
- 状态：已实施

## 目标与范围

在 Recorded vocabulary 页面的左侧菜单中，与 Vocabulary 并列新增 Synonym（近义词）。点击后，右侧详情区用 table 展示已记录的近义词，按 group 组织行。

最左列展示 group 的 meaning。同一 group 有几条词条，就将最左侧单元格合并几行；例如一个 group 有三条词条，组释义单元格必须跨三行，并在整个合并区域内水平、垂直居中。

本次包含菜单切换、分组列表读取、表格、分页和加载状态。详情页指菜单右侧内容区域，不新增逐词详情路由。删除、编辑、搜索、组重排和折叠不在本次范围内。

## 当前代码基线

- `src/renderer/src/recorded/RecordedPage.tsx` 目前只有默认选中的 Vocabulary 菜单，右侧为空；已具备返回、Escape 退出和进入时的焦点管理。
- `src/shared/synonym.ts` 已定义词条 `SynonymEntry`：`id`、`word`、`meaning`、`groupid`、`distinction`。
- `src/core/learning/synonym/synonym-repository.ts` 已有 `SynonymGroup`（`id`、`meaning`、`words`）和分页结构，但尚未作为 Renderer 的 Shared 读取协议。
- `src/database/sqlite-synonym-repository.ts` 的 `findGroups` 按组 ID 分页，每页五组、组内按 word 排序；现有查询超过每组 100 词或响应 60000 字符时会报 `SCAN_LIMIT`，面向模型工具扫描，不宜直接用作完整列表读取。
- `src/main/index.ts` 已初始化近义词收藏能力；Preload 尚未提供界面列表 API。
- 本计划与 `2026-09-09-recorded-vocabulary-detail.md` 共用 Recorded 页面入口。实施时按最新代码整合菜单状态、详情容器和通用样式，保留 Vocabulary 已有或随后实现的行为，不要求先完成该计划。

## 页面与交互

1. 进入 Recorded vocabulary 时仍默认选中 Vocabulary；左侧新增 Synonym，选中状态跟随当前菜单。
2. 点击 Synonym 后加载真实收藏数据，显示标题、分组表格和“加载更多”。切换回 Vocabulary 时恢复其详情区域。
3. 表格列固定为以下顺序，区分组释义与单词自身释义：

   | 列 | 数据来源 | 展示方式 |
   | --- | --- | --- |
   | 分组释义 | `group.meaning` | 最左列；跨该组全部词条行，水平与垂直居中 |
   | 单词 | `entry.word` | 每个词条一行 |
   | 单词释义 | `entry.meaning` | 保留换行，长文本自动换行 |
   | 用法区别 | `entry.distinction` | 保留换行，长文本自动换行 |

4. 按 `group.id` 确定分组，不能按 meaning 文本合并；释义相同但 ID 不同的组仍分别展示。组内行保持连续，组与组之间用边框区分。
5. 单词组包含一行时使用 `rowSpan={1}`；包含三行时使用 `rowSpan={3}`。分组释义只在第一行渲染一次，后续行不补空单元格、不重复渲染释义。
6. 使用真实 `table`、`thead` 和列标题，每个 group 使用独立 `tbody`，分组单元格使用 `th scope="rowgroup"` 和 `rowSpan={group.words.length}`。通过 `text-align: center` 与 `vertical-align: middle` 对齐；不将跨行单元格改为 flex，以免破坏原生表格布局。
7. 表格容器允许横向滚动；长组释义可换行，合并单元格的居中位置随整组实际高度变化。不使用逐行虚拟化或固定行高破坏跨行效果。为表格提供国际化的可访问名称。
8. 首次加载、无记录、读取失败分别展示状态，失败可重试；加载更多期间保留现有数据，失败仅在底部提示。状态变化提供可访问通知。
9. 菜单按钮支持键盘操作，保留页面返回、Escape、焦点恢复以及会话草稿行为。每次重新进入 Synonym 重新读取，切换或卸载后忽略旧请求结果，防止迟到响应覆盖新状态。
10. 静态标题、菜单、表头、状态和按钮使用中英文 i18n 资源；保存的释义和区别原文展示。列表读取不调用 LLM。

## 实施步骤

### 1. Shared 与 Core 读取协议

- 在 `src/shared/synonym.ts` 定义分组列表输入、分组对象、分页结果和安全错误的 Zod schema 与类型；Core 复用 Shared 类型，Renderer 不导入 Core。
- 输入使用可选 UUID 游标，分页以完整 group 为单位；成功结果包含 `groups` 与 `nextCursor: string | null`，通过 `status: 'ok' | 'error'` 区分成功和失败。
- 校验 group ID、非空 meaning、非空词条数组及词条 `groupid` 与所属组一致，避免无效的 `rowSpan={0}`。查询只返回有词条的组，空组不生成伪造词条行。
- 集中定义 `SYNONYM_CHANNELS`，新增稳定命名的 `synonym:list`；扩展 `src/shared/conversation.ts` 中的 `LingoMateApi`，提供窄接口 `window.api.synonym.list(input)`。
- 为近义词仓储新增面向界面的只读列表方法，并由 Core 的轻量查询服务协调；更新受影响的测试替身，保持收藏流程不变。

### 2. 数据读取与分页

- 新增界面列表查询，不改变模型工具使用的 `findGroups` 及其扫描预算。
- 每页取五个非空组，额外探测一个组判断是否存在下一页；按组 ID 升序，组内按 word、id 稳定排序，游标使用最后返回的组 ID。
- 在同一读取事务中取得组与全部成员，保证一次响应内部一致。使用参数化 SQL，复用 `synonym_group`、`synonym` 及现有存储错误封装。
- 一页必须返回完整组，不能按词条总数截断或将同组拆到两页；界面查询不继承模型扫描的 100 词和 60000 字符上限。分页追加按组 ID 去重，不重复渲染同一组。
- 当前方案完整渲染已加载的组；验证大组性能，后续若需优化须保留完整组与跨行语义，不静默截断内容。
- 预计无需 schema 迁移或持久化写入。若实施中需要迁移或操作真实持久化数据，须按 `AGENTS.md` 先询问用户；验证使用临时数据库。

### 3. Main 与 Preload

- 新增 `src/main/synonym-ipc.ts`，参考现有 IPC 模式检查可信窗口、主 frame 和 URL，验证输入与输出，将内部异常转换为安全错误码。
- 在 Main 复用近义词仓储实例，注入查询服务，注册并按生命周期清理 handler。
- 更新 `src/preload/index.ts`，同步核对 `src/preload/index.d.ts` 类型声明，校验桥接输入和结果。禁止向 Renderer 暴露原始 IPC、数据库、内部异常或高权限对象。

### 4. Renderer

- 在 `RecordedPage.tsx` 增加 `vocabulary | synonym` 菜单状态，选中按钮提供相应的 `aria-current`，按当前菜单渲染内容。
- 新增 `src/renderer/src/recorded/SynonymDetail.tsx`，负责列表状态和分组表格；使用 group ID 和词条 ID 作为稳定 key。
- 在 `src/renderer/src/assets/main.css` 增加分组单元格、组边框、换行、横向滚动及状态样式，适配现有主题。
- 在 `src/renderer/src/i18n/locales/zh-CN/common.json` 与 `en/common.json` 同步增加 `recorded.sections.synonym` 及详情相关 key。

## 验证与验收

- Shared / Core：分页参数、结果结构、组归属和错误转换校验。
- Database：完整分组、稳定顺序、组级分页、空组跳过、同释义不同 ID 不合并；覆盖超过 100 词和 60000 字符的数据，确保 UI 查询不被模型扫描预算拦截，同时现有工具限制保持有效。
- Main / Preload：可信来源检查、非法输入输出拒绝、安全错误映射和窄接口桥接。
- Renderer：菜单切换；单行、三行、多组的 DOM 结构与 `rowSpan`；组释义只出现一次、列数对齐；加载、空状态、失败重试、分页去重和迟到请求忽略。
- Electron / 浏览器视觉验收：三行组左侧实际合并三行，组释义在整个区域水平与垂直居中；含多行区别文本和长组释义时仍居中；窄窗口滚动、中英文和键盘导航正常。
- 测试遵守目录规范：单元与组件测试放对应 `__tests__/`，集成测试放 `tests/integration/`，端到端测试放 `tests/e2e/`；使用临时数据，不依赖模型调用。

实施完成后运行相关测试及项目检查：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:electron
```

验收通过标准：新增 Synonym 菜单可查看真实记录；表格最左列显示 group meaning，严格按同组词条数跨行合并且双向居中；分页不拆组，Vocabulary 与现有导航无回归。全部实施和验证完成后，将本计划状态更新为“已实施”。
