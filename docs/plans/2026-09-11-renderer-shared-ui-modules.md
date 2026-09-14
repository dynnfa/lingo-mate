# Renderer 公共 UI 模块层重构计划

- 日期：2026-09-11
- 状态：已实施
- 来源：[architecture-review-2026-09-11.html](../architecture-review-2026-09-11.html) 卡片 1「建立 Renderer 公共 UI 模块层」（Strong，首选推荐）

## 目标与范围

在 Renderer 内建立一层跨 menu 复用的公共 UI 模块（组件 + hooks），把当前散落在各 menu 目录里逐份复制的对话框、状态块、页面骨架、游标分页状态机和请求防护代码收敛为深模块：小接口、行为收在实现里、一处修复全局生效。本次是结构重构，不新增功能、不改变交互语义；除下文明示的「对话框视觉统一」外无用户可见变化。

重构动机（review 已核实的重复簇）：

- 8 处确认对话框内联 JSX，分属两套互不相通的样式家族（`settings-confirm` 无遮罩、无 `aria-modal`；`dialog-backdrop`/`dialog-card` 有遮罩），且没有任何一处实现焦点陷阱。
- 约 9 处 loading/error/empty 三态块，CSS 已用逗号选择器合并（`main.css:197-231`），JSX 却仍在逐份复制。
- 3 个页面骨架（Settings / Recorded / Practice）结构逐行等价，同一个返回箭头 SVG 路径复制 3 份，挂载聚焦与 Escape 退出 effect 复制 3 份。
- 3 份游标分页列表状态机（VocabularyDetail / PhraseDetail / SynonymDetail）80–90% 相同，合计约 900 行；每份都自带 `mountedRef`、双序号守卫、去重、删除过滤。
- 请求防护存在 4 种互不相同的写法（boolean busy / ref 锁 + 判别状态 / 序号守卫 / effect 内 cancelled 标志），无任何共享 hook。
- 9 处错误码 → i18n key 映射，`UNKNOWN_ERROR` 重复映射 9 次、`UNTRUSTED_SOURCE` 7 次、`INVALID_INPUT` 7 次、`STORAGE_FAILED` 5 次。

不在本次范围：

- 不改动 conversation 区域的控制器模式（`conversation-controller.ts` + `useSyncExternalStore`），其流式生命周期是独立问题。
- 不收敛 practice hooks 内的多阶段序号守卫（start/hints/review 各自的 seq），只迁移单向请求防护。
- 不整体拆分 `main.css`（2,416 行），只删除因迁移而失效的规则块；也不引入 Tailwind 或任何第三方组件库，所有模块手写、零新增依赖。
- 不触碰 IPC、Core、Database 与进程边界（对应 review 卡片 2/5/6，另行处理）。
- 不做视觉重设计。唯一有意的行为变化：设置区对话框统一获得遮罩、`aria-modal` 与焦点陷阱（见风险节）。

## 现状基线

### 确认对话框（8 处，0 个共享组件）

| 站点 | 位置 | 样式家族 | 焦点陷阱 |
| --- | --- | --- | --- |
| 设置页退出放弃 | `settings/SettingsPage.tsx:189-213` | settings-confirm | 无 |
| 模型删除 | `settings/models/ModelsSettings.tsx:179-224` | settings-confirm | 无 |
| 模型表单放弃 | `settings/models/ModelsSettings.tsx:226-252` | settings-confirm | 无 |
| 模型行测试结果 | `settings/models/ModelsSettings.tsx:254-282` | settings-confirm | 无 |
| 词汇删除 | `recorded/vocabulary/VocabularyDetail.tsx:310-352` | dialog-card | 无 |
| 短语删除 | `recorded/phrase/PhraseDetail.tsx:288-328` | dialog-card | 无 |
| 句子练习开新一轮 | `practice/sentence/SentencePracticeDetail.tsx:373-400` | dialog-card | 无 |
| 词汇练习开新一轮 | `practice/vocabulary/VocabularyPracticeDetail.tsx:293-324` | dialog-card | 无 |

两套 CSS：`.dialog-backdrop/.dialog-card/.dialog-actions/.dialog-danger-button`（`assets/main.css:1017-1085`）与 `.settings-confirm*`（`assets/main.css:1460-1513`）。所有站点均为回调驱动；Escape 处理分裂为两种机制——recorded/practice 在遮罩 `onKeyDown` 自行处理，settings 依赖页面级 `handleKeyDown`（`SettingsPage.tsx:94-105`）逐层转发到 `useModelsSettings.consumeEscape()`（`useModelsSettings.ts:585-612`）。

### 三态块（约 9 处）

- `settings/models/ModelsSettings.tsx:60-62, 64-75, 119-123`
- `settings/usage/UsageSettings.tsx:27-42, 44-55, 127-140`（含骨架屏与过期刷新横幅）
- `recorded/vocabulary/VocabularyDetail.tsx:213-229`、`recorded/phrase/PhraseDetail.tsx:205-221`、`recorded/synonym/SynonymDetail.tsx:112-128`（三者互为逐行克隆）
- `practice/sentence/SentencePracticeDetail.tsx:102-123, 140-161, 205-212`
- `practice/vocabulary/VocabularyPracticeDetail.tsx:134-162, 228-235, 243-250`
- 列表底部加载更多三态（moreError / loadingMore / 按钮）另复制 3 份：`VocabularyDetail.tsx:283-302`、`PhraseDetail.tsx:261-280`、`SynonymDetail.tsx:164-183`

### 页面骨架（3 份）

`settings/SettingsPage.tsx:107-214`、`recorded/RecordedPage.tsx:31-72`、`practice/PracticePage.tsx:35-71`。CSS 已通过多重选择器合并（`main.css:56-165`），复制的是 JSX、SVG 与 effect。差异仅两点：Settings 的详情面板 `keepMounted + hidden`（表单草稿保留），另两个页面按需卸载。

### 游标分页状态机（3 份克隆 + 2 个变体）

`VocabularyDetail.tsx:17-122`、`PhraseDetail.tsx:18-121`、`SynonymDetail.tsx:14-104`。共享形态：`loadState` 三态、`entries`、`nextCursor`、`loadError`、`loadingMore`、`moreError`，加 `mountedRef`/`entriesRef`/`nextCursorRef`/`initialSeqRef`/`moreSeqRef`/`deletedIdsRef` 六个 ref。Vocabulary 与 Phrase 逐行相同（仅实体字段与 i18n 前缀不同）；Synonym 少删除流。变体：模型列表全量快照（`useModelsSettings.ts:187-220`）、用量快照 + 刷新态（`useUsageStatistics.ts:24-74`），本次不强行并入。

### 请求防护（4 种写法）

- 写法 A（boolean busy + finally 复位）：`settings/ui-language/UiLanguageSection.tsx:48-70`、`settings/target-language/TargetLanguageSection.tsx:44-65`
- 写法 B（ref 锁 + 判别 busy 态）：`settings/models/useModelsSettings.ts:346-394, 413-440, 443-462`（saveEdit / confirmDelete / setActive 各一份）
- 写法 C（mountedRef + 序号守卫，promise 链）：3 个 recorded 详情 + usage + 2 个 practice hooks（由 useCursorList 与既有代码分别吸收）
- 写法 D（effect 内 cancelled 标志）：两个语言设置区块的初次加载

### 错误码映射（9 处）

`recorded/{vocabulary,phrase,synonym}/*-messages.ts`、`settings/{models,usage}/*-messages.ts`、`practice/{sentence,vocabulary}/*-messages.ts`、`preferences/preferences-failure.ts`、`conversation/status-messages.ts`。均为「穷尽 Record + getter」配方。`status-messages.ts:136,148` 跨域复用 `errors:models.credentialDecryptFailed`。

### 其他核实项

- `base.css` 未定义 `--color-danger`，`main.css` 里 12 处依赖 `var(--color-danger, #b42318)` 兜底。
- i18n 泄漏：`ConversationPanel.tsx:263` 硬编码 `'Lingo Mate'` 角色标签；`UsageSettings.tsx:340` 与 `TokenUsageChart.tsx:314` 硬编码全角 `'；'`。语言自名（`UiLanguageSection.tsx:13-15` 的 `'中文'`/`'English'`）为有意设计，保留。
- 测试：Vitest + Testing Library，jsdom 按文件开启；现有页面测试（`SettingsPage.test.tsx` 等）是本次迁移的行为基线。

## 目标结构

```text
src/renderer/src/
├── components/            # 跨 menu 公共 UI 模块（AGENTS.md：跨 menu 能力按职责存放）
│   ├── ConfirmDialog.tsx / ConfirmDialog.css / use-focus-trap.ts
│   ├── StateBlock.tsx / StateBlock.css
│   ├── LoadMoreBar.tsx / LoadMoreBar.css
│   ├── PageShell.tsx / PageShell.css
│   └── __tests__/         # 各组件测试
└── hooks/                 # 跨 menu 数据 hooks
    ├── use-cursor-list.ts
    ├── use-ipc-request.ts
    └── __tests__/
```

三条设计原则：

1. **组件不持有文案。** 所有 label/message 经 props 由调用方传入翻译后的字符串。共享组件因此无需 i18n Provider 即可测试，也避免 locale 资源随组件 churn。
2. **新模块 CSS 就近共置。** 沿用 `conversation/markdown-message.css` 的先例；`main.css` 只删不增。
3. **每个模块单独可落地。** 阶段之间无硬依赖（除第 0 阶段），可按阶段独立提交与回滚。

## 模块设计

### ConfirmDialog

```ts
export interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  confirmLabel: string
  cancelLabel: string
  tone?: 'default' | 'danger'      // 默认 'default'；danger 决定确认按钮样式
  busy?: boolean                    // true 时双按钮禁用（删除进行中）
  error?: string | null             // 操作失败文案，按钮上方以 role="alert" 渲染
  initialFocus?: 'confirm' | 'cancel'  // 默认 'cancel'（破坏性操作的安全默认）
  returnFocusRef?: React.RefObject<HTMLElement | null>  // 关闭后焦点归还目标
  onConfirm: () => void
  onCancel: () => void
  children?: React.ReactNode        // 少数站点（模型行测试结果）的附加内容插槽
}
```

实现吸收的行为：遮罩 + `role="dialog"` + `aria-modal` + `aria-labelledby`/`aria-describedby`；`Escape → onCancel`（遮罩 `onKeyDown` 内 `stopPropagation`，取代 settings 的页面级转发层）；Tab/Shift+Tab 焦点循环陷阱（`use-focus-trap.ts`，约 20 行，零依赖）；打开时初始聚焦、关闭时归还 `returnFocusRef`；`busy`/`error` 的按钮态。`open === false` 时不渲染。

迁移点：上表 8 处全部改为 `<ConfirmDialog>`。各站点删除本地 JSX、`handleDialogKeyDown`、初始聚焦 effect；词汇/短语删除后的「邻行焦点归还」属列表逻辑，由调用方在删除完成后自行聚焦（见 useCursorList 阶段）。设置区 4 处获得遮罩与 `aria-modal`（有意变更，见风险节）；`consumeEscape` 转发层随迁移删除。

### StateBlock

```ts
export interface StateBlockProps {
  variant: 'loading' | 'empty' | 'error'
  message?: string          // loading 可省略；error/empty 必传
  onRetry?: () => void      // 仅 error：渲染重试按钮
  retryLabel?: string
  skeleton?: boolean        // 仅 loading：渲染骨架占位（usage 场景）
}
```

语义内置：loading → `role="status"` + `aria-busy`；error → `role="alert"`；empty 无特殊 role。迁移点：上节三态块清单中的页面级三态（含 practice 页的 start/review 错误块）。usage 的「过期数据 + 刷新失败」横幅是复合语义，保持本地实现。

### LoadMoreBar

```ts
export interface LoadMoreBarProps {
  hasMore: boolean
  loadingMore: boolean
  error: string | null       // 底部加载失败文案
  retryLabel: string
  label: string              // 「加载更多」按钮文案
  onLoadMore: () => void
}
```

吸收 3 份列表底部三态（`moreError` alert / `loadingMore` status / 按钮 + `hasMore` 隐藏逻辑）。

### PageShell

```ts
export interface PageShellSection {
  id: string
  label: string
  content: React.ReactNode
  keepMounted?: boolean      // true：非激活时渲染但 hidden（设置页草稿保留不变量）
}

export interface PageShellProps {
  title: string
  exitLabel: string          // 返回按钮 aria-label
  onExit: () => void
  className?: string         // 页面专属样式钩子（现 settings-page 等）
  sections: PageShellSection[]
}
```

内部持有 `activeSectionId`（三页现状均无外部控制需求）。吸收：`aside + menu-header(返回按钮 + SVG + 标题) + nav(aria-current 菜单) + detail` 结构、挂载聚焦返回按钮、`Escape → onExit`。`keepMounted` 区块用 `hidden` 隐藏。设置页的「脏表单先确认再退出」由其 `onExit` 回调内部组合 ConfirmDialog 实现，PageShell 不感知。迁移点：3 个页面容器，各自保留菜单项数据与详情内容。

### useCursorList

```ts
export interface CursorPage<T> {
  entries: T[]
  nextCursor: string | null
}

export interface UseCursorListOptions<T> {
  load: (cursor: string | null) => Promise<CursorPage<T>>
  keyOf: (entry: T) => string
}

export interface CursorList<T> {
  phase: 'loading' | 'ready' | 'error'
  entries: T[]
  nextCursor: string | null
  loadingMore: boolean
  moreError: boolean
  reload: () => void            // 清空后回到初始加载
  loadMore: () => void          // 内置 cursor/loadingMore 守卫与按 key 去重
  removeEntry: (key: string) => void  // 本地移除并记入已删集合，后续加载过滤
}
```

实现吸收：`mountedRef` 卸载防护、`initialSeqRef`/`moreSeqRef` 过期响应丢弃、`entriesRef`/`nextCursorRef` 一致性、`loadMore` 去重、`deletedIdsRef` 重载过滤。三个 recorded 详情页降为「fetch 函数 + keyOf + 渲染」，预计每页从约 330 行降到约 150 行。模型/用量两个快照式列表不并入（无游标语义，强行统一会把接口撑宽）。

### useIpcRequest

```ts
export function useIpcRequest<TArgs extends unknown[], TResult>(
  request: (...args: TArgs) => Promise<TResult>,
  handlers?: { onComplete?: (result: TResult) => void; onError?: (error: unknown) => void }
): {
  pending: boolean
  error: unknown | null      // 调用方沿用各自错误码映射表转文案
  run: (...args: TArgs) => Promise<TResult | null>  // pending 期间静默忽略（防双击）
  reset: () => void
}
```

迁移点：写法 A 的两个语言区块、写法 B 的 saveEdit / confirmDelete / setActive（各自一个 hook 实例，busy 判别态由 `pending` + 调用方语义标签组合）。写法 D 的初次加载 effect 一并改用（cancelled 语义由 hook 的 mounted 防护覆盖）。写法 C 中被 useCursorList 吸收的部分随上一阶段消失；practice hooks 的多阶段序号守卫明确不在本次范围。

### 错误码映射收敛（可独立延后）

新增 `src/renderer/src/i18n/error-messages.ts`：

```ts
export type ErrorMessages<TCode extends string> = Record<TCode, string>

// 领域映射 → 公共映射 → errors:unknown 的三层回退
export function createErrorKeyResolver(common: ErrorMessages<string>): <T extends string>(
  domain: ErrorMessages<T>,
  code: T | string | null | undefined
) => string
```

`UNKNOWN_ERROR`/`UNTRUSTED_SOURCE`/`INVALID_INPUT`/`STORAGE_FAILED` 等跨域重复条目收敛进公共映射（新增 `errors:common.*` key，en 与 zh-CN 同步补齐）；领域文件只保留领域专属条目。同时把 `status-messages.ts:136,148` 对 `errors:models.credentialDecryptFailed` 的跨域复用改为 conversation 域自己的 key。各领域文件的穷尽性类型检查保持不变（新增错误码仍会在编译期暴露漏配站点）。

### CSS 与 token 收敛

- `base.css` 补定义 `--color-danger: #b42318`，移除 `main.css` 中 12 处兜底值（行为不变，消除悬空引用）。
- 随各阶段删除失效块：`.settings-confirm*`（1460-1513）、`.dialog-*`（1017-1085，由 `ConfirmDialog.css` 取代）、三态变体选择器（197-231 等）、页面骨架多重选择器（56-165，由 `PageShell.css` 取代单份）。
- 预计 `main.css` 从 2,416 行降到约 1,700–1,900 行。不做整体拆分。

### i18n 泄漏修复

- `ConversationPanel.tsx:263`：`'Lingo Mate'` 角色标签改为 `t('common:messages.assistantRole')`；两个 locale 的值可自行决定是否保留拉丁品牌名，但必须走资源文件。
- `UsageSettings.tsx:340`、`TokenUsageChart.tsx:314`：硬编码全角 `'；'` 改为 `i18n/formatters.ts` 新增的 locale 感知列表分隔符格式化；`UsageSettings.tsx:340` 的 `'—'` 占位符改走资源。

## 实施步骤

每阶段独立提交，结束时 `pnpm lint`、`pnpm typecheck`、`pnpm test` 必须全绿。

### 第 0 阶段：准备（约 0.25 天）

创建 `components/`、`hooks/` 目录；`base.css` 定义 `--color-danger` 并清理 12 处兜底。

### 第 1 阶段：ConfirmDialog（约 1 天）

实现组件 + `use-focus-trap` + 测试（打开/关闭、Escape 触发 onCancel 且不冒泡到页面、Tab 焦点循环、busy 禁用、error alert、initialFocus、关闭后焦点归还）；迁移 8 处站点；删除 `consumeEscape` 转发层；更新受影响页面测试的选择器（优先 role/text 查询）。

### 第 2 阶段：StateBlock（约 0.5 天）

实现 + 测试（三种 variant 的 role 与 aria、retry 回调、skeleton）；迁移页面级三态；删除对应 CSS 变体。

### 第 3 阶段：PageShell（约 1 天）

实现 + 测试（菜单切换、`keepMounted` 面板 `hidden` 且草稿保留、Escape 退出、挂载聚焦返回按钮）；迁移 3 个页面容器；更新页面测试。

### 第 4 阶段：useCursorList + LoadMoreBar（约 1 天）

实现 + `renderHook` 测试（初始加载、loadMore 去重与守卫、过期响应丢弃、removeEntry 过滤、reload 重置）；迁移 3 个 recorded 详情；接入 LoadMoreBar；删除各页本地状态机。

### 第 5 阶段：useIpcRequest（约 0.5 天）

实现 + 测试（pending 防重入、错误捕获、reset、卸载后不落盘 state）；迁移写法 A/B/D 站点。

### 第 6 阶段：错误码映射收敛（约 0.5 天，可独立延后）

三层回退 + 公共映射 + locale 补齐 + 跨域 key 修正；各领域消息文件测试保持通过。

### 第 7 阶段：i18n 泄漏 + 收尾（约 0.25 天）

泄漏修复与 locale 更新；全局搜索确认无孤儿 class（对已删选择器名执行 `rg` 反查 JSX）；运行全量 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`；`pnpm dev` 手动冒烟（清单见验收）；将本文件状态更新为「已实施」。

## 验证与验收

- 8 处确认对话框全部渲染 `<ConfirmDialog>`；对话框打开期间 Tab 不离开对话框（测试断言焦点循环），关闭后焦点回到 `returnFocusRef` 目标。
- `VocabularyDetail` / `PhraseDetail` / `SynonymDetail` 共享 `useCursorList`，文件行数各降到约 150 行；分页、删除、重载行为与迁移前一致（以现有测试 + 新增 hook 测试为准）。
- 设置页菜单切换时模型表单草稿保留（`keepMounted` 不变量，`SettingsPage.test.tsx` 既有用例零改动通过）。
- `main.css` 降至约 1,700–1,900 行；对每个被删除的选择器名反查，JSX 中无残留引用。
- 组件测试无需 i18n Provider（组件零内置文案）；所有新增用户可见文案（错误映射公共 key、assistantRole、分隔符）在 en 与 zh-CN 同步补齐。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test` 全部通过。
- `pnpm dev` 冒烟清单：删除词汇/短语（含失败路径）、模型增删改与连接测试、设置页脏表单退出确认、三个页面 Escape 退出与焦点归还、recorded 列表翻页与底部失败重试、练习页开新一轮确认。

## 风险与对策

- **设置区对话框视觉变化**：从无遮罩的 `settings-confirm` 变为带遮罩的统一家族，是有意的行为收敛（补齐 `aria-modal` 与焦点陷阱）。若需保留差异，可经 `tone`/`className` 扩展，但默认统一。
- **Escape 分层**：迁移后对话框在遮罩层吞掉 Escape，页面级退出逻辑不再需要 `consumeEscape` 转发；用组件测试锁住「对话框打开时页面不退出」。
- **焦点归还的站点特例**：词汇/短语删除后的邻行聚焦是列表语义，留在调用方，ConfirmDialog 只负责通用归还；测试覆盖两条路径。
- **测试选择器脆性**：迁移前先把依赖 class 名的断言改为 role/text 查询，再动实现。
- **回滚**：每阶段独立提交，可单独 revert；共享模块无外部依赖方时删除即回滚。
