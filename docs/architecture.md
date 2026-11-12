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

桌面直输和选择器都通过 `send` 发送命令原文，类型化 `runSkill` 继续作为兼容入口。 `ConversationModule` 先登记请求、取得会话互斥并冻结语言和渠道权限。随后 `conversation/routing.py` 的独立 `conversation-route` 图基于本次请求的命令首词和参数描述选择工作流。支持 `/concept`、`/vocabulary`、`/phrase`、`/synonym`、`/explore-phrase`、`/explore-vocabulary`、`/sentence` 和 `/tts`。

自然语言仅在桌面入口进行一次只读分类，候选为概念讲解和普通回复。分类器只能读取最新消息。普通对话和概念图各自接收绑定后的会话历史。渠道入口按已准入操作限定为普通回复或句子收录，通信控制命令由通信层处理。会话标题和练习有独立入口。

宿主核验唯一终态及请求权限，校验原始参数后保存用户消息并发布 `started`。选中的工作流以独立 Python 运行身份启动，共用本次宿主请求的语言快照和取消信号。保存前取消会保留草稿，已开始的工作流沿用既有阶段、报告和安全错误。协议和预算见 [Agent Engine README](../agent-engine/README.md#对话入口路由)。

### TypeScript 通用运行层

`PythonAgentRuntime` 的每次运行仅保存当前任务绑定与通用运行账本。公开入口通过 `agent-task-binding.ts` 的判别联合静态选择对应 Adapter，不能为一个运行组合多种可选领域 Host。可信 `agent-task-policy.ts` 统一定义权限、预算、并发、流事件模式与完成帧；Main 负责通信、身份、队列、截止和取消，`AgentHost` 负责调用防护、实际调用前的预算预留和输出计量。

任务专属的操作／回执解析、准备顺序、绑定索引、模型依赖与完成核验位于 `src/core/agent/tasks/`。领域 Host 继续保留内容、轮次授权、事务及完成账本。Main 仅在成功帧与当前策略匹配、全部宿主调用结束且 Adapter 核验通过后释放结果；业务提交仍由原有领域 Module 执行。所有任务拒绝提前成功，终止后的回执不触发再次核验或重放。

Python 是唯一 Agent 运行时，跨语言协议由 Zod 生成。详细接口与计量口径见 [Agent Engine README](../agent-engine/README.md#typescript-宿主任务边界)。

### TypeScript 领域实现归属

领域接口、规则、Host、具体模型 Adapter、专属工具定义与校验及其单元测试聚合在 `src/core/learning/<功能>/`。模型实现保留 `llm-` 文件名前缀；句子练习提示与点评共用的 `llm-sentence-practice-completion.ts` 同样位于 `sentence-practice/`。Main 构造并注入具体 Adapter，领域 Module 继续通过已有 Interface 接收依赖。SQLite 仓储实现保留在 `src/database/`，可引用领域内容类型与校验。

`src/core/llm/` 维护跨功能的模型配置、客户端、供应商传输、流式处理、用量及连接测试；`tool-protocol.ts` 和 `tool-request-policy.ts` 也保留在此，供领域 Adapter 复用。通用模型生产代码不依赖学习功能的类型、错误或实现，原 `src/core/tools/` 中的专属实现已全部归入各功能目录。文件归属不改变 Python 持有 Prompt 与执行流程的边界、宿主授权或业务提交语义；搬迁清单与验证见[领域实现归位计划](plans/2026-10-27-ts-domain-implementation-colocation.md)。

### TypeScript 会话执行与恢复

`src/core/conversation/conversation-module.ts` 保留会话入口、草稿与初始消息保存、普通回复流和后台标题任务。技能执行按持久化语义分开：

- `explore-conversation-execution.ts` 管理探索技能的执行、稳定回复身份、运行期未提交记录、文件批次恢复及淘汰保护。已提交批次只恢复本地回复；缺失批次只有当前进程确认未提交时才能在用户显式重试后重新生成，提交结果不确定时不授予重新生成权限。
- `stored-conversation-skill-runner.ts` 管理 SQLite 技能执行记录、阶段与原子回复提交。完整报告只恢复反馈；近义词的未完成报告沿原执行继续处理，保留逐词提交结果。
- `conversation-execution.ts` 统一管理从路由到生成的请求身份、会话互斥、取消与退出等待。终态发布时释放请求和会话归属，后台标题也计入退出等待范围。持久化错误包装、安全错误映射与诊断集中在 `conversation-errors.ts`，消息展示转换由 `conversation-message.ts` 复用。

已有技能按持久化的身份、参数和执行阶段恢复。仅有用户消息的历史记录通过只读入口重试，避免把升级前的斜杠文本执行为写入命令。SQLite schema 和探索历史文件格式支持原有记录。

### 近义词 Agent

`/synonym` 沿用现有显式命令、选择器和报告界面，由 Python / LangGraph 持有 Prompt 与顺序多轮工具流程。TS 的运行账本保管模型消息、供应商回放状态、工具参数及分组内容；Python 只取得绑定索引、轮次和安全回执。Main 装配的唯一近义词模块串行处理跨会话批次，后续词能查询前面新建的分组。

近义词保留逐词事务：词条与对应未完成报告同时提交。取消保留已有结果并生成本地报告；引擎故障、协议错误及 180 秒批次硬截止明确失败，未完成报告在用户显式重试时继续剩余词。完整报告只恢复回复，不重跑模型或存储。每词仍受 60 秒、52 轮、50 页限制；不继承词汇和短语的双并发、120 秒分析窗口及整批统一提交方式。详情见[近义词迁移计划](plans/2026-10-22-synonym-langgraph-agent.md)。

`/explore-phrase` 的 Prompt 和最多三轮补足由独立 Python / LangGraph 图持有。TS 运行级账本保留历史快照、排除列表、候选校验和模型配置，Python 仅取得计数、轮次与输入大小回执。跨会话串行锁覆盖历史读取、生成、图终态核验及 JSON 原子提交；结果仍保留最近 7 批，每批 10 项。取消和故障不提交部分结果，提交开始后等待存储实际结果再解锁；已提交表格沿用本地恢复。Renderer 与 Preload 接口保持原样，界面不接收图状态或候选载荷。详情见[探索短语迁移计划](plans/2026-10-22-explore-phrase-langgraph-agent.md)。

`/explore-vocabulary` 同样由独立 Python / LangGraph 图持有 Prompt 与三轮补足，TS 宿主校验单词词形、规范化去重及例句完整词形。它与探索短语分别持有权限、串行锁、JSON 历史及恢复身份，保留 10 项、最近 7 批和相同的原子提交边界。Renderer 与 Preload 接口不变；迁移与验收见[探索词汇迁移计划](plans/2026-10-23-explore-vocabulary-langgraph-agent.md)。

句子练习的提示生成及答案点评均通过 Python 的独立任务与 LangGraph 图执行，Prompt 在 `agent-engine/` 中维护。Renderer 沿用现有 Preload API 和会话操作，只展示校验后的提示、点评及安全错误。TS 宿主持有抽词、词条／提示快照、答案、模型传输和取消；Python 只接收输入大小及完成回执，图完成核验后才释放结果，不新增持久化练习记录。

词汇练习批改由 Python 的 `vocabulary-practice-review` 任务持有 Prompt、多轮标红及补标策略。TS 绑定抽词快照、答案、参考释义及完整模型／工具消息，Python 只接收轮次、分类与输入大小。宿主校验 `vocabulary_practice_result` 后才释放结果并保存错题，保留整批保存及 requestId 幂等重试。开始练习的窗口拥有批改和取消权限，窗口销毁时取消；引擎故障显示安全错误并保留用户答案，后续仅由用户显式提交新请求。

`/tts` 沿用类型化对话技能入口，通过 Python 的确定性单节点图调用宿主 HeadTTS，模型调用预算为 0。首次消息使用本地标题，音频与逐词时间轴保存于 SQLite；消息通过安全描述渲染内嵌播放器，按会话和消息身份读取音频，不向 Renderer 暴露路径。生成完成后等待点击播放，点词跳转保持播放或暂停状态。所有朗读共享一个播放控制器，页面及会话切换停止播放；底部全局播放器已移除，词条朗读在来源旁显示状态和错误。

## 公共通信与外部平台边界

`src/core/communication/` 持有平台无关的绑定、确认、会话映射、Inbox、调度及 Outbox 规则；`src/main/communication/` 装配凭据、业务端口、静态 Adapter 和可信管理 IPC，`src/database/` 实现增量迁移与原子通信仓储。设置页的 channels 区块遵循 PageShell 原有隐藏挂载和焦点规则。

渠道使用独立请求归属，不伪造窗口 IPC。`ConversationModule.createPersistentConversation` 解决内存草稿的重启问题，可信执行 context 显式传入每次语言快照和消息身份，业务仍使用唯一 Python Agent。首版仅开放普通文本与 `/sentence`；恢复依据精确持久化消息或 sentence 报告，不能证明结果时不重放。当前没有生产平台 Adapter，也不因此宣称支持任何平台。接口、预算、保留期及接入验收见[公共通信接入指南](communication-adapters.md)。
