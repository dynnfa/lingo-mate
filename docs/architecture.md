# Renderer 视图渲染模式：状态驱动切换，无路由

## 状态

- 状态：Current（2026-10-21 核对；初始决策于 2026-09-05）
- 适用范围：`src/renderer`
- 相关实现：[App.tsx](../src/renderer/src/App.tsx)、[useAppViewNavigation.ts](../src/renderer/src/hooks/useAppViewNavigation.ts)、[SettingsPage.tsx](../src/renderer/src/settings/SettingsPage.tsx)、[PageShell.tsx](../src/renderer/src/components/PageShell/PageShell.tsx)

## 声明

Lingo Mate 的 Renderer **没有引入任何路由**。视图的渲染与切换完全由 React 状态驱动：`useAppViewNavigation` 持有顶层视图状态，`App.tsx` 根据该状态条件渲染对应视图，不经过 URL、history 或任何路由库的调度。

`package.json` 当前不包含 `react-router-dom`，现有视图切换也不依赖路由库。

## 机制

### 顶层视图切换

视图类型和导航逻辑定义在 `src/renderer/src/hooks/useAppViewNavigation.ts` 中：

```ts
type AppView = 'conversation' | 'settings' | 'recorded' | 'practice' | 'mistakes'
```

- `<main className="chat-shell">`（对话视图）**始终挂载**，进入任一子页面时通过 `hidden={activeView !== 'conversation'}` 隐藏。
- 设置、已记录、练习、错题页分别由 `SettingsPage`、`RecordedPage`、`PracticePage`、`MistakesPage` 作为兄弟节点条件挂载；退出后卸载对应子页面。
- `useAppViewNavigation` 提供 `openView`、`returnToConversation` 和各入口按钮的 ref。返回对话时，hook 通过 `previousViewRef` 比较前后视图，把焦点还给打开该子页面的入口按钮。

### 隐藏而非卸载

进入设置、已记录、练习或错题页时对话视图不卸载，是一个有意的不变量，原因是 `ConversationPanel` 与会话列表的运行期状态依赖挂载树的连续性：

1. 输入框中未发送的草稿是 `ConversationPanel` 的本地状态。
2. 消息区滚动位置依赖 DOM 连续性。
3. 生成中的流式回复投影由 `useSyncExternalStore` 订阅维护，卸载会打断 UI 侧的连续性。
4. e2e 的就绪探测依赖 `main[data-phase]` 始终存在于 DOM。

配套约束：`.chat-shell` 自身声明了 `display: grid`，会覆盖浏览器对 `hidden` 属性的默认 `display: none`，因此 `main.css` 中必须保留显式规则：

```css
.chat-shell[hidden] {
  display: none;
}
```

### 设置页内部导航

设置页（`SettingsPage.tsx`）内部同样是状态驱动：区块在 `SETTINGS_SECTIONS` 数组中注册，由公共 `PageShell` 管理菜单与详情切换，并通过 `onSectionChange` 同步设置页中的 `activeSectionId` 镜像，用于 Escape 分层处理等交互。设置区块使用 `keepMounted: true`，切换菜单时隐藏详情而不卸载，保留模型表单草稿；退出整个设置页仍会卸载该页面，并先处理未保存修改的确认。这不构成路由层级，只是页内状态。

## 扩展方式

新增一个顶层视图时：

1. 在 `useAppViewNavigation.ts` 的 `AppView` 联合类型中追加成员，并为新的子页面补充入口按钮 ref 和返回时的焦点恢复映射。
2. 在 `App.tsx` 中绑定入口按钮，通过 `openView` 打开页面，按状态条件挂载新页面，并将退出回调接入 `returnToConversation`。对话视图继续保持挂载并隐藏，其他子页面沿用条件挂载，额外保留状态需明确设计。
3. 明确进入页面、返回、Escape 和未保存修改时的焦点与关闭行为，并补充相应交互测试。

不要为新视图引入路由库或 URL 状态。

## 何时重新评估

当前单窗口、五个顶层视图、无深链需求的场景下，状态切换仍是现行方案。出现以下需求时再重新评估路由：

- 需要可分享/可恢复的视图深链（如 `settings/language` 直达）。
- 需要浏览器式历史栈（后退键逐级返回）。
- 视图数量增长到需要按路由做代码分割。

在重新评估之前，本文件声明的设计是当前有效决策：**视图切换是状态，不是路由。**
