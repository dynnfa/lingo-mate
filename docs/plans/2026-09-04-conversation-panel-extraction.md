# ConversationPanel 拆分计划

## 状态与目标

- 状态：Implemented（2026-09-04 实施完成，见文末实施记录）。
- 目标：将 `App.tsx` 右侧对话区整体提取为 `conversation/ConversationPanel.tsx`，明确页面编排与对话交互的边界，保持现有界面及会话行为。
- 范围：Renderer 组件及相关测试；不修改 Controller、会话状态机、IPC、Core 或数据库。
- 关联计划：[Canonical Message 与生成生命周期](./2026-09-03-canonical-message-lifecycle.md)、[i18n 国际化](./2026-09-04-i18n-internationalization.md)。

## 现状与拆分理由

`src/renderer/src/App.tsx` 约 220 行，同时负责 Controller 生命周期、会话侧栏、语言设置和对话区。右侧 `conversation-panel` 约 68 行 JSX，包含标题与状态、消息列表与空状态、重试按钮和输入表单，具有完整的组件职责。

`draft` 和表单提交处理只服务于右侧，可以随组件下移；Controller 和订阅状态同时服务于侧栏与右侧，继续由 `App` 持有。此次拆分主要改善维护和独立测试，不以文件行数或组件复用为前提。

仅提取一个 `ConversationPanel`，暂不继续拆分 Header、MessageList、MessageItem 或 Composer，不引入 Context、额外 Store、通用 Hook 或 memo 优化。

## 文件与职责

| 文件                                                       | 变更及职责                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/src/App.tsx`                                 | 保留 Controller 创建、attach/initialize/清理、状态订阅、侧栏、设置弹窗及启动偏好提示；计算交互状态，向面板传入数据与回调 |
| `src/renderer/src/conversation/ConversationPanel.tsx`      | 新增具名导出的组件；接收展示数据，管理输入草稿，展示整个右侧区域并提交用户交互意图                                       |
| `src/renderer/src/conversation/ConversationPanel.test.tsx` | 新增聚焦组件接口及输入行为的测试                                                                                         |
| `src/renderer/src/App.test.tsx`                            | 保留既有集成测试，补充草稿跨会话切换及新建会话的回归覆盖                                                                 |

沿用现有 CSS 类名及 DOM 结构，原则上无需修改样式。复用现有翻译 key；搬迁时发现尚未封装的用户静态文本，应使用翻译资源承载，并同步 `zh-CN` 与 `en`，保持展示内容不变。

## 组件接口

类型复用 Renderer 内的 `conversation-state.ts`，不新增 Shared 协议：

```ts
import type { ConversationStatus, DisplayMessage } from './conversation-state'

interface ConversationPanelProps {
  messages: DisplayMessage[]
  status: ConversationStatus
  generating: boolean
  composerLocked: boolean
  onSend: (text: string) => void
  onCancel: () => void
  onRetry: (messageId: string) => void
}
```

`App` 保持现有派生逻辑：

```ts
const generating = isGenerating(state)
const composerLocked = state.phase !== 'ready' || generating || state.commandPending
```

接入方式：

```tsx
<ConversationPanel
  messages={state.messages}
  status={state.status}
  generating={generating}
  composerLocked={composerLocked}
  onSend={(text) => void controller.send(text)}
  onCancel={() => void controller.cancel()}
  onRetry={(messageId) => void controller.retry(messageId)}
/>
```

回调只表达交互意图，不返回成功与否；异步结果仍通过 Controller 的状态投影反馈。必须用包装回调调用 Controller，避免直接传递依赖 `this` 的实例方法。

面板不接收整个 Controller 或 `ConversationState`，不直接访问 `window.api`，不自行订阅或初始化会话。消息与状态由 props 提供，不复制到组件本地 state。

## 状态及行为约束

1. **输入草稿归面板所有。** 将 `draft`、`setDraft` 和表单事件处理移入面板。提交时先阻止默认行为；锁定或输入全为空白时不发送；有效提交先清空输入，再调用 `onSend(draft)`。继续传入原始草稿，由 Controller 完成 trim；不改为等待发送成功后清空，也不新增失败恢复草稿。
2. **保持面板稳定挂载。** 在现有布局位置直接渲染，不添加 `key={sessionId}` 或语言 key，不根据 loading/failed 状态卸载。当前切换、新建会话均不主动清空未发送草稿，此行为保持不变；切换语言和打开设置也应保留草稿。
3. **按钮行为不变。** 输入框受 `composerLocked` 控制；非生成时发送按钮由空白输入或锁定状态禁用；生成时显示 `type="button"` 的取消按钮。重试仅对 `role === 'user' && retryable && !composerLocked` 的消息显示，并传递该消息的 `messageId`。
4. **消息身份及展示不变。** 保留 `key={message.messageId}`、`data-message-id`、角色样式及空内容占位。流式消息更新、完成、失败和取消的解释仍由现有 Controller 与状态机承担。
5. **国际化由组件按当前语言执行。** 面板内部使用 `useTranslation(['common', 'conversation', 'errors'])` 和现有 `translateConversationStatus`。不缓存翻译后的状态，不从 `App` 传递翻译函数；不翻译用户输入或历史消息。
6. **布局与无障碍不变。** 保留 `conversation-panel` 根节点、标题层级、状态的 `aria-live="polite"`、消息区域及输入框的可访问名称、输入长度上限 4000，以及按钮类型。`chat-shell` 和 `data-phase` 留在 `App`。

草稿下移后，输入更新不再由 `App` 的本地 state 触发；流式状态仍在 `App` 订阅，本计划不承诺减少流式更新引起的父组件渲染。

## 实施步骤

- [x] 新建 `ConversationPanel.tsx`，按上述接口整体迁移右侧 JSX、草稿状态、提交处理及状态翻译。
- [x] 在 `App.tsx` 中接入组件，删除已迁移的状态、函数及无用 import；保持 Controller 生命周期和侧栏逻辑。
- [x] 核对 DOM、样式类名、可访问属性和现有翻译资源；如需补齐静态文本 key，同步两种语言资源。（未发现需新增的 key，品牌名与装饰性标记沿用原样，未修改翻译资源。）
- [x] 新增面板组件测试，并在 `App.test.tsx` 补齐状态归属变更带来的草稿保留回归测试。
- [x] 执行验证命令，确认差异范围；在本计划记录实施结果及验证结果。

## 测试与验收

组件测试使用现有 Vitest、Testing Library、`createI18n` 和真实翻译资源，使用 spy 回调，不构造完整 IPC mock。重点验证边界行为：

- 锁定或全空白输入不能发送；有效表单提交仅调用一次 `onSend`、传递原始文本并清空输入。
- 从可输入状态切到锁定状态保留草稿；生成时显示取消按钮，点击触发 `onCancel`，不提交表单。
- 重试按钮只在允许的消息及交互状态下出现，并将正确的 `messageId` 传给 `onRetry`。
- 空消息列表显示空状态；传入消息和状态后正确更新展示，不缓存旧 props。

复用 `App.test.tsx` 现有恢复、流式生命周期、取消、重试、会话切换及语言设置测试，不在新组件测试中重复模拟完整协议。补充未发送草稿在切换及新建会话后保留的集成断言，保留已有的语言切换不丢草稿、不重建会话状态的测试。

实施后执行：

```bash
pnpm exec vitest run src/renderer/src/conversation/ConversationPanel.test.tsx src/renderer/src/App.test.tsx
pnpm lint
pnpm typecheck
pnpm build
```

若补充了翻译资源，同时运行 `src/renderer/src/i18n/resources.test.ts`。当前改动由组件及集成测试覆盖，不新增 Electron E2E 基础设施。

验收标准：`App` 不再包含右侧消息列表、输入表单和草稿状态；面板通过明确 props 与回调工作；原有界面、发送/取消/重试、会话切换和语言切换行为保持；上述验证通过，且没有新增跨进程依赖或改变会话协议。

## 实施记录（2026-09-04）

- 新增 `src/renderer/src/conversation/ConversationPanel.tsx`：具名导出，接收 `ConversationPanelProps` 七个 props；`draft` 状态、表单提交处理与状态翻译（`translateConversationStatus` + `useTranslation(['common', 'conversation', 'errors'])`）随组件下移；DOM 结构、类名、无障碍属性与原文案逐行保持。
- `src/renderer/src/App.tsx`：删除 `draft` 状态、`sendMessage`、`SyntheticEvent` 与 `translateConversationStatus` import，右侧 JSX 替换为 `<ConversationPanel>`；`generating`/`composerLocked` 派生逻辑、Controller 生命周期、侧栏与设置弹窗保持不变。
- `src/renderer/src/conversation/ConversationPanel.test.tsx`：8 个用例覆盖空状态、props 更新不缓存、锁定/全空白不发送、有效提交传原始文本且清空输入、锁定时保留草稿、生成时取消按钮不提交表单、重试按钮的显示条件与 `messageId` 传递。
- `src/renderer/src/App.test.tsx`：新增切换会话与新建会话后未发送草稿保留的两条集成回归；其余既有用例未改动。
- 未修改翻译资源、CSS、Controller、状态机、IPC、Core 与数据库；无新增跨进程依赖。

验证结果（全部通过）：

- `pnpm exec vitest run src/renderer/src/conversation/ConversationPanel.test.tsx src/renderer/src/App.test.tsx`：33 passed（8 + 25）。
- 全量 `pnpm exec vitest run`：17 个文件、178 个测试全部通过（含未改动的 `resources.test.ts`）。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`：通过。
- 差异范围：`App.tsx`（-78/+11）、`App.test.tsx`（+38）、新增 `ConversationPanel.tsx` 与 `ConversationPanel.test.tsx`。
