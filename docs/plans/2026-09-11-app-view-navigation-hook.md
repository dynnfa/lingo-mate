# App 视图导航 Hook 重构计划

- 日期：2026-09-11
- 状态：待实施

## 目标与范围

将 `App.tsx` 中的顶层视图切换与焦点恢复逻辑抽成独立的 `useAppViewNavigation` hook，降低 `App.tsx` 的职责密度。本次是纯结构重构：不改变任何用户可见行为，不新增视图，不引入路由库。

重构动机：

- `App.tsx` 目前同时承担会话控制器装配、启动偏好提示、视图切换状态、三个入口按钮的 ref 与焦点恢复 effect，职责持续累积。
- 视图切换 + 焦点恢复是一段自洽的状态机（activeView、previousView、entry refs），整体搬出后 `App.tsx` 只消费一个 hook 返回值。
- 为将来新增视图（届时只需在 `AppView` 联合类型与 refs 记录中追加条目）和跨页跳转到具体区块（hook 返回值可扩展 open 参数）留出接缝。

不在本次范围：

- 不引入 react-router-dom（已于 2026-09-11 从依赖移除）或任何 URL/history 机制。
- 不修改三个子页面（Settings / Recorded / Practice）的 `onExit` 回调契约、Escape 分层和内部焦点管理。
- 不改变对话主视图保持挂载并用 `hidden` 隐藏的策略。

## 当前代码基线

- `src/renderer/src/App.tsx`：
  - `type AppView = 'conversation' | 'settings' | 'recorded' | 'practice'`（第 16 行）。
  - `const [activeView, setActiveView] = useState<AppView>('conversation')`（第 40 行）。
  - `settingsButtonRef` / `recordedButtonRef` / `practiceButtonRef` / `previousViewRef` 四个 ref（第 44–47 行）。
  - 焦点恢复 effect（第 56–68 行）：仅在回到 `conversation` 且前一视图为三个子页面之一时，把焦点还给对应入口按钮；初次挂载 `previousViewRef` 初始为 `'conversation'`，不抢焦点。
  - JSX 中三个入口按钮直接调用 `setActiveView(...)`，三个子页面通过 `onExit={() => setActiveView('conversation')}` 退出（第 192–200 行）。
- `src/renderer/src/__tests__/App.test.tsx`：`App recorded page navigation`、`App practice page navigation` 与设置页相关用例已覆盖“打开页面 → 隐藏对话视图 → 返回后焦点恢复到对应入口”，是本次重构的行为基线。

## Hook 设计

### 文件与类型

新文件 `src/renderer/src/useAppViewNavigation.ts`（应用级公共能力，放 renderer 根目录，与 `App.tsx` 同级；hook 文件沿用项目 camelCase 命名，如 `useModelsSettings.ts`）。

`AppView` 类型从 `App.tsx` 迁移至此并导出，`App.tsx` 改为从 hook 导入。新增一个“子页面视图”类型，收窄可主动打开的目标：

```ts
export type AppView = 'conversation' | 'settings' | 'recorded' | 'practice'

export type SecondaryView = Exclude<AppView, 'conversation'>
```

### API 契约

```ts
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { AppView, SecondaryView } from './useAppViewNavigation'

export interface AppViewNavigation {
  /** 当前激活视图，初始为 'conversation' */
  activeView: AppView
  /** 打开一个子页面视图 */
  openView: (view: SecondaryView) => void
  /** 返回对话视图（供子页面 onExit 调用） */
  returnToConversation: () => void
  /** 三个入口按钮的 ref，由 App.tsx 绑定到侧栏按钮 */
  entryButtonRefs: {
    settings: RefObject<HTMLButtonElement | null>
    recorded: RefObject<HTMLButtonElement | null>
    practice: RefObject<HTMLButtonElement | null>
  }
}
```

### 实现要点

状态与 effect 整体从 `App.tsx` 平移，焦点查找从 if/else 链改为按下标取 ref（`SecondaryView` 的三个值与 refs 记录的键一一对应，可静态索引）：

```ts
export function useAppViewNavigation(): AppViewNavigation {
  const [activeView, setActiveView] = useState<AppView>('conversation')
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const recordedButtonRef = useRef<HTMLButtonElement>(null)
  const practiceButtonRef = useRef<HTMLButtonElement>(null)
  const previousViewRef = useRef<AppView>('conversation')

  const entryButtonRefs = {
    settings: settingsButtonRef,
    recorded: recordedButtonRef,
    practice: practiceButtonRef
  }

  // 从子页面返回对话视图时，把焦点还给对应入口按钮；初次挂载不抢焦点。
  useEffect(() => {
    const previousView = previousViewRef.current
    if (activeView === 'conversation' && previousView !== 'conversation') {
      entryButtonRefs[previousView].current?.focus()
    }
    previousViewRef.current = activeView
  }, [activeView])

  const openView = (view: SecondaryView): void => {
    setActiveView(view)
  }

  const returnToConversation = (): void => {
    setActiveView('conversation')
  }

  return { activeView, openView, returnToConversation, entryButtonRefs }
}
```

需保留的既有语义（重构验收对照项）：

- 焦点恢复仅在“从子页面回到 conversation”时触发；初次挂载、在子页面之间停留都不触发。
- `previousViewRef` 记录的是“紧邻的上一个视图”。当前可见 UI 不存在子页面间直接互跳的路径（入口按钮位于隐藏视图内），但 hook 保持逐次记录语义，与现状一致。
- 重复点击同一入口（测试中以 `hidden: true` 模拟）不产生额外副作用，对话数据不重载。

### App.tsx 接入后

```tsx
const { activeView, openView, returnToConversation, entryButtonRefs } = useAppViewNavigation()
```

- 三个入口按钮：`onClick={() => openView('recorded')}`、`ref={entryButtonRefs.recorded}`，以此类推。
- 三个子页面：`<SettingsPage onExit={returnToConversation} />`，以此类推。
- 删除 `App.tsx` 中的 `activeView` state、四个 ref、焦点恢复 effect 与本地 `AppView` 类型定义。

## 实施步骤

### 1. 新建 hook

创建 `src/renderer/src/useAppViewNavigation.ts`，包含类型迁移、状态、refs 与焦点恢复 effect，导出 `AppViewNavigation` 接口。

### 2. 改造 App.tsx

替换 state / refs / effect 为单次 hook 调用，更新入口按钮与子页面的接线；`App.tsx` 从 hook 文件导入 `AppView`（如仍有引用）。

### 3. 测试

- `src/renderer/src/__tests__/App.test.tsx` 现有断言不修改，全部保持通过——这是“行为不变”的主验收门。
- 新增 `src/renderer/src/__tests__/useAppViewNavigation.test.ts`，用 `renderHook` 覆盖 hook 单元行为：
  - 初始 `activeView` 为 `'conversation'`，挂载时不移动焦点；
  - `openView('recorded')` 切换视图；
  - `returnToConversation()` 后焦点落在与前一视图对应的入口按钮上（三个视图各一例）；
  - 打开子页面期间 effect 不触发 focus。

### 4. 收尾

运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`；确认通过后将本文件状态更新为“已实施”。

## 验证与验收

- `pnpm lint`、`pnpm typecheck`、`pnpm test` 全部通过，其中 `App.test.tsx` 的导航、Escape 退出、焦点恢复、草稿保留、重复点击不重载等既有用例零改动通过。
- `App.tsx` 不再包含视图切换 state、entry refs 与焦点恢复 effect；上述逻辑唯一存在于 `useAppViewNavigation.ts`。
- 手动冒烟（`pnpm dev`）：打开设置 / 已记录 / 练习页 → 返回按钮或 Escape 退出 → 焦点回到对应入口；对话草稿与滚动位置在往返后保留；子页面打开期间后台流式生成不中断。
- 无用户可见文案变化，不涉及 i18n 资源与数据库变更。
