# 设置按钮改为跳转独立设置页（左侧菜单 + 右侧详情）

## 方案概述

去掉 `LanguageSettings` 模态弹窗，改为应用级视图切换：点击设置按钮进入设置页；设置页左侧是菜单侧栏，右侧是对应详情区。菜单先只放"语言"一项（如实反映现有唯一设置），结构上预留扩展点。

采用状态驱动切换（`activeView: 'conversation' | 'settings'`），不引入 react-router——与现有代码风格一致，两视图用路由属过度设计。

关键约束：`ConversationPanel` 内部保存未发送草稿且 `App.test.tsx:915-955` 保证切换语言不丢草稿、`data-phase` 被 e2e `waitForReady` 依赖。因此进入设置页时**隐藏而不卸载**对话视图。

## 改动清单

### 1. `src/renderer/src/App.tsx`
- `settingsOpen` 布尔状态 → `activeView: 'conversation' | 'settings'`。
- 设置按钮（122–136 行）：移除 `aria-haspopup="dialog"` 和 `aria-expanded`（改为页面导航语义），`onClick` → `setActiveView('settings')`；保留 `.settings-button` 类名与 `ref`。
- `<main className="chat-shell">` 加 `hidden={activeView === 'settings'}`（保持挂载：草稿、滚动位置、controller 订阅、`data-phase` 均保留）；`preference-notice` 随之隐藏（启动提示，可接受）。
- `closeSettings` → `exitSettings`：`setActiveView('conversation')` + 焦点还给设置按钮（保留现有焦点恢复行为）。
- `activeView === 'settings'` 时渲染 `<SettingsPage onExit={exitSettings} />` 作为兄弟节点。

### 2. 新建 `src/renderer/src/settings/SettingsPage.tsx`
- Props：`onExit: () => void`；内部 `activeSectionId` 状态（默认 'language'）。
- 模块内 sections 数组（当前仅一项）：`{ id: 'language', labelKey: 'common:settings.sections.language', Component: LanguagePreferenceSection }`，后续新增设置直接加条目。
- 布局 `<main className="settings-page">`（grid: 220px | 1fr）：
  - `<aside className="settings-menu">`：顶部返回按钮（← 图标 + `settings.back`）与标题 `settings.title`；`<nav aria-label={settings.menuLabel}>` 内菜单按钮，选中项用 `aria-current="true"`。
  - `<section className="settings-detail">`：`<h2>` 当前区块名 + 区块组件。
- 挂载时焦点移入页面（返回按钮）；根节点 Escape → `onExit`（延续现有 Escape 关闭行为）。

### 3. 提取 `src/renderer/src/preferences/LanguagePreferenceSection.tsx`
- 从 `LanguageSettings.tsx` 原样迁移表单逻辑：mount 时 `getLocale` 加载、单选 `setLocale` 保存、成功后 `i18n.changeLanguage`、`failureCode` alert、`saving` 期间禁用。
- 删除 dialog 外壳、role="dialog"、焦点陷阱、Escape、Close 按钮。
- 删除 `LanguageSettings.tsx` 文件。

### 4. `src/renderer/src/assets/main.css`
- 删除 `.settings-overlay`、`.settings-dialog`、`.settings-actions*`。
- 保留 `.language-fieldset`、`.language-option`、`.settings-error`。
- 新增 `.chat-shell[hidden] { display: none }`（`.chat-shell` 的 `display: grid` 会覆盖 UA 的 hidden 样式）、`.settings-page`、`.settings-menu`、`.settings-menu-header`、`.settings-back-button`、`.settings-menu-item`（含 active 态）、`.settings-detail`，全部复用现有 design tokens，风格对齐 `session-sidebar` / `sidebar-menu-item`，并处理 760/520px 断点。

### 5. i18n（zh-CN 与 en 同步更新）
- 新增：`settings.back`（返回 / Back）、`settings.menuLabel`（设置菜单 / Settings menu）、`settings.sections.language`（语言 / Language）。
- 删除不再使用的 `settings.close`。
- `i18next.d.ts` 类型随 zh-CN JSON 自动更新；`resources.test.ts` 会校验两语言 key 对齐。

### 6. 测试更新
- `preferences/__tests__/LanguageSettings.test.tsx` → 改写为 `LanguagePreferenceSection.test.tsx`：保留原有 7 个测试意图（当前偏好渲染、保存并切换 i18n、保存中防重复提交、写失败保留原选择、读失败 alert、IPC reject）。
- 新建 `settings/__tests__/SettingsPage.test.tsx`：菜单渲染与区块切换、返回按钮、Escape 返回、挂载焦点管理。
- `src/renderer/src/__tests__/App.test.tsx` `describe('App language settings')`（914–1014 行）：改为——设置按钮进入设置页（无 dialog）、Escape 返回并恢复设置按钮焦点、设置页内切换语言草稿不丢（对话视图隐藏不卸载）、保存失败保留原语言；启动提示测试不动。
- e2e `tests/e2e/helpers.ts` `switchLanguage`（45–59 行）：`getByRole('dialog')` 断言改为设置页选择器，`.settings-actions button` 改为返回按钮；`tests/e2e/language-switch.test.ts`（126、132 行）同步更新选择器。

### 7. 验证
- `pnpm lint`、`pnpm typecheck`、`pnpm build`。
- 运行相关 vitest（preferences / settings / App 测试）及 i18n resources 测试。