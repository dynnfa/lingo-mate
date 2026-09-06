# Renderer 视图渲染模式：状态驱动切换，无路由

## 状态

- 状态：Current（2026-09-05）
- 适用范围：`src/renderer`
- 相关实现：[App.tsx](../src/renderer/src/App.tsx)、[SettingsPage.tsx](../src/renderer/src/settings/SettingsPage.tsx)

## 声明

Lingo Mate 的 Renderer **没有引入任何路由**。视图的渲染与切换完全由 React 组件内的状态驱动：`App.tsx` 持有一个视图状态，根据该状态条件渲染对应视图，不经过 URL、history 或任何路由库的调度。

`react-router-dom` 目前作为依赖存在于 `package.json`，但在 `src/` 中没有任何导入和使用。它是历史遗留依赖，不是本模式的组成部分；是否移除由依赖清理流程决定，与视图切换机制无关。

## 机制

### 顶层视图切换

视图状态定义在 `App.tsx` 中：

```ts
type AppView = 'conversation' | 'settings'
```

- `<main className="chat-shell">`（对话视图）**始终挂载**，进入设置页时仅添加 `hidden` 属性隐藏。
- `activeView === 'settings'` 时，`<SettingsPage onExit={...} />` 作为兄弟节点条件挂载。
- 从设置页返回时，通过 `previousViewRef` 比较前后视图，把焦点还给触发跳转的设置按钮。

### 隐藏而非卸载

进入设置页时对话视图不卸载，是一个有意的不变量，原因是 `ConversationPanel` 与会话列表的全部运行期状态都活在挂载树里：

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

设置页（`SettingsPage.tsx`）内部同样是状态驱动：左侧菜单与右侧详情由组件内的 `activeSectionId` 状态切换，区块在 `SETTINGS_SECTIONS` 数组中注册。这不构成路由层级，只是页内状态。

## 扩展方式

新增一个顶层视图时：

1. 向 `AppView` 联合类型追加成员。
2. 在 `App.tsx` 中按状态条件渲染新视图，并决定既有视图是隐藏还是卸载（默认沿用"隐藏保挂载"）。
3. 明确进入/退出时的焦点去向。

不要为新视图引入路由库或 URL 状态。

## 何时重新评估

当前单窗口、两视图、无深链需求的场景下，状态切换是最小且可测试的方案。只有当出现以下需求时才应重新评估路由：

- 需要可分享/可恢复的视图深链（如 `settings/language` 直达）。
- 需要浏览器式历史栈（后退键逐级返回）。
- 视图数量增长到需要按路由做代码分割。

在重新评估之前，本文件声明的设计是当前有效决策：**视图切换是状态，不是路由。**
