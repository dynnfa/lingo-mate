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

## 对话技能执行边界

`/phrase` 与 `/vocabulary` 的显式命令入口继续使用现有会话界面和 Preload API；它们不是页面路由。两者的分析 Prompt 和批量执行由 Python / LangGraph 持有，Renderer 仅展示原有阶段、报告和安全错误。词条内容与报告在可信宿主统一提交，不把图状态或内部工具载荷暴露给界面。运行时职责与协议 v7 见 [Python Agent ADR](adr/2026-10-21-python-langgraph-agent-engine.md)。

### 近义词 Agent

`/synonym` 沿用现有显式命令、选择器和报告界面，由 Python / LangGraph 持有 Prompt 与顺序多轮工具流程。TS 的运行账本保管模型消息、供应商回放状态、工具参数及分组内容；Python 只取得绑定索引、轮次和安全回执。Main 装配的唯一近义词模块串行处理跨会话批次，后续词能查询前面新建的分组。

近义词保留逐词事务：词条与对应未完成报告同时提交。取消保留已有结果并生成本地报告；引擎故障、协议错误及 180 秒批次硬截止明确失败，未完成报告在用户显式重试时继续剩余词。完整报告只恢复回复，不重跑模型或存储。每词仍受 60 秒、52 轮、50 页限制；不继承词汇和短语的双并发、120 秒分析窗口及整批统一提交方式。详情见[近义词迁移计划](plans/2026-10-22-synonym-langgraph-agent.md)。

`/explore-phrase` 的 Prompt 和最多三轮补足由独立 Python / LangGraph 图持有。TS 运行级账本保留历史快照、排除列表、候选校验和模型配置，Python 仅取得计数、轮次与输入大小回执。跨会话串行锁覆盖历史读取、生成、图终态核验及 JSON 原子提交；结果仍保留最近 7 批，每批 10 项。取消和故障不提交部分结果，提交开始后等待存储实际结果再解锁；已提交表格沿用本地恢复。Renderer 与 Preload 接口保持原样，界面不接收图状态或候选载荷。详情见[探索短语迁移计划](plans/2026-10-22-explore-phrase-langgraph-agent.md)。

`/explore-vocabulary` 同样由独立 Python / LangGraph 图持有 Prompt 与三轮补足，TS 宿主校验单词词形、规范化去重及例句完整词形。它与探索短语分别持有权限、串行锁、JSON 历史及恢复身份，保留 10 项、最近 7 批和相同的原子提交边界。Renderer 与 Preload 接口不变；迁移与验收见[探索词汇迁移计划](plans/2026-10-23-explore-vocabulary-langgraph-agent.md)。
