# Lingo Mate 项目指南

## 项目定位

Lingo Mate 是一个桌面端语言学习助手 Agent。它通过对话、记忆和大语言模型能力，为用户提供持续、个性化的语言学习体验。

技术栈为 Electron、React、TypeScript，以及负责 Agent 策略与编排的 Python / LangGraph，并使用三层架构：

1. Electron 桌面运行层
2. React 用户界面层
3. Agent Engine 核心能力层（Python 策略与编排、TypeScript 宿主能力）

Python 是唯一 Agent 运行时；普通对话、会话标题生成、`/concept`、`/vocabulary`、`/phrase`、`/synonym`、`/explore-phrase`、`/explore-vocabulary`、句子练习（提示和点评）与词汇练习批改始终经过 Python，任务识别、Prompt 与执行流程由 Python 持有。未来新增 Agent 策略和工作流统一在 `agent-engine/` 实现，TypeScript 不再维护并行 Agent 执行路径。其余现有显式技能及练习暂沿用 TS 实现，后续迁移。启动、协议或执行故障必须明确失败，不得静默回退或重放失败请求。架构边界见 [Python Agent ADR](docs/adr/2026-10-21-python-langgraph-agent-engine.md)。

## 目录职责

```text
src/
├── main/           # Electron 主进程；agent/ 负责 Python 子进程与通信适配
├── preload/        # IPC Bridge，Renderer 与 Main 之间的安全桥接层
├── core/           # TypeScript 领域与可信宿主能力
│   ├── agent/      # AgentRuntime 接口、宿主安全校验与跨语言协议
│   ├── llm/        # 模型客户端、模型配置与流式响应
│   ├── memory/     # 规划模块，尚未实现：长期学习记忆与检索
│   ├── tools/      # Agent 工具定义与执行
│   ├── prompt/     # 尚未迁移的技能及练习 Prompt
│   ├── learning/   # 语言学习领域逻辑
│   └── conversation/ # 会话模型、消息流与上下文组装
├── database/       # SQLite schema、迁移、连接与数据访问
├── shared/         # 跨层共享的 TypeScript 类型与协议
└── renderer/       # React 用户界面
```

```text
agent-engine/       # 唯一 Agent 策略、Prompt 与 LangGraph 编排，不持有业务存储与模型凭据
├── src/lingo_agent/ # 图、运行状态、JSONL 协议与运行服务
└── build/          # PyInstaller 运行包构建与烟测
```

### `src/main`

负责 Electron 主进程能力，包括：

- 应用生命周期与窗口管理
- 注册和处理 IPC 请求
- 调用操作系统、文件系统等 Node.js 能力
- 创建并协调 `src/core` 中的 Agent 服务
- 通过 `src/main/agent/` 管理 Python 子进程生命周期、JSONL 通信和宿主调用适配

主进程只负责桌面应用编排，不应包含 React UI 或具体的学习业务逻辑。

### `src/preload`

负责主进程与网页 Renderer 之间的安全桥接，包括：

- 使用 `contextBridge` 暴露最小化、明确命名的 API
- 为暴露的 API 提供 TypeScript 类型声明
- 将 Renderer 请求转换为 IPC 调用

不要直接向 Renderer 暴露 `ipcRenderer`、Electron 原始 API、Node.js 模块、文件系统或其他高权限对象。preload 应暴露面向业务场景的窄接口，而不是通用的 `send`、`invoke` 或任意 channel 调用能力。新增桥接 API 时，应同步更新 `src/preload/index.ts` 和 `src/preload/index.d.ts`。

### `src/renderer`

负责 React 用户界面，包括：

- 页面、组件和基于 React 状态的视图切换
- UI 状态与交互逻辑
- 展示对话、学习内容、Agent 状态与错误信息
- 通过 `window.api` 调用 preload 提供的能力

Renderer 必须视为纯浏览器环境，不得直接导入或调用任何 Electron API，包括但不限于 `ipcRenderer`、`shell`、`webFrame`、`remote` 以及 Electron 主进程模块；也不得直接使用 Node.js API、访问文件系统、数据库或导入 `src/core`。

凡是需要 Electron、操作系统、文件系统、数据库或其他高权限能力的功能，都必须先在 Main 中实现受控处理，再通过 preload 使用 `contextBridge` 暴露为明确类型的 `window.api` 接口，由 Renderer 调用。不得通过开启 `nodeIntegration`、关闭 `contextIsolation` 或向 Renderer 暴露原始 IPC 对象来绕过该边界。

业务规则应下沉到 Agent Engine，不要隐藏在 React 组件中。

当前视图切换不使用路由库或 URL 状态；扩展时遵循 [Renderer 视图架构](docs/architecture.md)，保留对话视图隐藏时的挂载状态及进入、退出视图时的焦点管理。

页面目录按 menu 组织：根目录只保留外层页面容器及其 `__tests__/`，每个 menu 使用独立子目录（如 `recorded/phrase/`、`settings/models/`），收拢该 menu 的组件、hooks 和辅助函数。menu 专属测试放在对应子目录的 `__tests__/` 中。跨 menu 或应用级公共能力按实际职责存放，不复制到各 menu，也不归入某个单独 menu。

hook 文件统一使用 camelCase 命名，且文件名与导出的 hook 函数名保持一致，例如 `useCursorList.ts` 导出 `useCursorList`；不得使用 kebab-case（如 `use-cursor-list.ts`）。

### `src/core`

负责与界面无关的可信宿主能力和语言学习业务逻辑，按以下领域拆分：

```text
src/core/
├── agent/          # AgentRuntime、宿主能力与跨语言协议契约
├── llm/            # 模型配置、传输适配和流式响应
├── memory/         # 规划模块，尚未实现：长期学习记忆与检索
├── tools/          # Agent 工具定义与执行
├── prompt/         # 尚未迁移的技能及练习 Prompt
├── learning/       # 语言学习领域逻辑
└── conversation/   # 会话模型、消息流和上下文组装
```

核心逻辑应尽量通过明确接口与依赖注入连接 LLM、存储和系统能力，以便独立测试。不要从 `src/core` 导入 React 组件或 Renderer 状态。

`memory/` 当前仅为规划职责，不代表已有记忆提取、持久化或召回实现；实施范围见 [长期学习记忆计划](docs/plans/2026-10-21-long-term-learning-memory.md)。

### `agent-engine`

负责独立 Python 子进程中的 Agent 任务识别、Prompt、工具决策、LangGraph 图、单次运行的内存状态与有界编排。会话生命周期、学习领域规则、模型适配、凭据、供应商请求、取消、用量统计及持久化继续由 TypeScript 宿主持有；Python 生成完整系统指令，通过受控宿主调用复用能力，不直接请求模型供应商或访问业务数据库，不启用 checkpoint 或跨运行 Store。

- Main 使用固定可执行路径、`shell: false` 和环境白名单启动进程；Renderer 不得指定命令、路径或环境。生产运行包不依赖系统 Python、uv 或 PATH。
- Main 与 Python 通过私有 UTF-8 JSONL 管道通信，stdout 专用于协议；stderr 仅由 Main 有界接收并写入本地诊断日志，不进入 Renderer 或控制台。
- Python 不得接收 API Key、数据库连接信息或外层会话/消息 ID；宿主调用必须经过白名单、运行归属及预算校验。生产普通对话仅开放携带 `systemPrompt` 的 `model.reply`；独立 `conversation-title` 任务仅开放 `model.title`，Python 持有标题 Prompt 和单节点图，宿主忽略思考并以 `conversation-title` 用途调用模型；只携带首条 user 消息，最多 1 次模型调用、0 次工具调用、1 个操作步骤，含启动总截止 120 秒，实际输入／原始正文上限为 32,768／80 个 UTF-16 单元，TS 仍校验最多 40 字符的单行标题并保存；词汇任务另开放 `vocabulary.prepare` 与携带 `systemPrompt`、绑定词项索引的 `model.vocabulary`；短语任务仅开放 `phrase.prepare` 与 `model.phrase`，同样通过绑定索引和完整 `systemPrompt` 分析。分析内容与入库元数据留在宿主；Prompt 上限为 4096 个 UTF-16 单元，宿主与 Python 均校验输入预算（对话为 Prompt 加历史；词汇及短语为 Prompt、绑定词项与工具定义）。词汇及短语每批最多 20 项、并发 2、分析窗口 120 秒，硬截止 180 秒；图完成核验后才由宿主同步提交。近义词任务独立开放 `synonym.prepare`、`model.synonym`、`synonym.apply` 和 `synonym.finish`，仅交换绑定索引、轮次、完整 Prompt 与安全回执，完整模型消息和工具参数／结果留在宿主。Python 顺序驱动多轮工具流程，宿主校验待执行决策、查询授权和逐词事务；已提交词在取消或故障后保留。近义词每批最多 20 项、每词 60 秒／52 轮／50 页，取得串行执行权后总硬截止 180 秒（包含启动）；模型／非模型宿主调用／步骤预算为 1040／1061／2200，单轮实际模型输入 65,536、累计安全回执 524,288 UTF-16 单元。词汇和短语预算保持原样。探索短语任务仅开放 `explore-phrase.prepare` 与 `model.explore-phrase`，Python 持有完整 Prompt 和最多三轮串行补足；TS 保留最近 7 批历史、候选校验与内容。Python 只取得轮次、已接受数量和输入大小回执，不接收历史与候选正文。每批固定 10 项，最多 3 次模型调用／1 次准备调用／8 个步骤，单次请求 60 秒，取得串行锁后准备与生成总截止 180 秒（包含启动）；实际输入 65,536、累计安全回执 32,768 UTF-16 单元。核验图终态且凑齐 10 项后才原子替换 JSON 历史；提交阶段等待实际存储结果再释放锁。探索词汇使用独立的 `explore-vocabulary.prepare` 与 `model.explore-vocabulary`，由 Python 持有 `explore-vocabulary-tools-v1` Prompt 和独立三轮补足图；宿主保留单词词形、规范化、去重及完整词形例句校验。其计数回执、10 项、7 批历史、调用与字符预算、截止时间及提交边界与探索短语相同；两者的权限、锁、历史文件和恢复身份相互隔离。句子练习使用独立的 `sentence-practice-hints` 与 `sentence-practice-review` 任务，仅开放 `sentence-practice.prepare` 和各自携带完整 `systemPrompt` 的模型调用。Python 持有原有 Prompt 与单次调用图，宿主绑定词条、释义、提示和答案，只跨管道发送输入大小及完成回执；图终态核验后才释放校验结果。每次模型／准备调用／步骤为 1／1／2，含启动总截止 120 秒，供应商请求 60 秒；实际输入／累计安全回执／Prompt 上限为 65,536／1,024／4,096 个 UTF-16 单元。抽词、会话与请求归属、结果校验和取消留在宿主，不写练习历史。词汇练习批改使用独立 `vocabulary-practice-review` 任务，仅开放 `vocabulary-practice.prepare`、`model.vocabulary-practice-review`、`vocabulary-practice.apply`、`vocabulary-practice.correct` 和 `vocabulary-practice.finish`。Python 持有完整 Prompt、多轮流程及最多两次补标指令；宿主保留词条／答案／参考释义、完整消息、工具参数和结果，只交换轮次、分类、大小与完成回执。每次最多 8 次模型调用、10 次非模型宿主调用、18 个步骤；含启动总截止 120 秒、供应商请求 60 秒；输入／累计回执／Prompt 上限为 65,536／4,096／4,096 个 UTF-16 单元。图完成核验后才返回批改结果并保存错题；现有 requestId 成功缓存及保存重试保持幂等，失败不自动重放。IPC 校验窗口归属并在窗口销毁时取消。测试扩展不等于生产授权。
- 协议唯一来源为 `src/core/agent/agent-protocol.ts` 中的 Zod schema。`agent-engine/src/lingo_agent/protocol/schema.json` 为生成物，不得手改；协议变更需同步共享契约用例，破坏性变更还需提升协议版本、同步握手与运行包 manifest 并重建运行包。

开发环境、协议演进、构建与分发细节见 [Agent Engine README](agent-engine/README.md)。

### `src/database`

负责 SQLite 基础设施，包括 schema、迁移、数据库连接、事务和数据访问实现。数据库实现不得被 Renderer 直接导入或调用；应由 Main 或 Core 中定义的接口进行协调。

### `src/shared`

负责跨进程、跨层共享的 TypeScript 类型、IPC channel 常量和可序列化协议。该目录不得包含依赖 Electron、React、Node.js 运行时或具体业务执行逻辑的代码，避免共享类型反向引入高权限实现。

## 依赖方向

依赖应保持单向：

```text
React Renderer -> Preload API -> Electron Main -> TypeScript Core
                                            -> Database / OS / network
                                            <-> Python / LangGraph（私有 JSONL）
```

图中的 Python 双向箭头表示协议通信；Python 不能绕过 Main 直接访问 TypeScript 实现或存储。宿主调用由 Main 校验并分派到 Core。

- Renderer 只能通过 preload 暴露的 `window.api` 请求 Electron 及其他高权限能力，禁止直接调用 Electron API。
- Preload 只定义安全边界和数据传输，不实现业务逻辑。
- Main 负责调用、生命周期和进程间编排。
- Core 保存可复用、可测试的领域逻辑，不依赖 UI。
- Python 持有 Agent 策略、Prompt 与受控编排，不成为模型凭据、业务事务或持久化状态的所有者。
- Database 提供 SQLite 基础设施和数据访问实现，不依赖 Renderer。
- Shared 仅承载跨层类型与协议，不承载高权限实现或业务逻辑。
- 跨边界传输的数据必须可序列化，并使用明确的 TypeScript 类型；外部输入应使用 Zod 等方式校验。

## 开发约定

- Electron、Renderer 和宿主领域代码使用 TypeScript，避免无必要的 `any` 和 `@ts-ignore`；`agent-engine/` 使用 Python 类型标注，并通过既有 Ruff 与严格 mypy 检查。
- 保持模块职责单一；组件、IPC handler 和 Agent 工具不应承担多个领域职责。
- IPC channel 使用稳定、可读的领域命名，并集中定义，避免散落的字符串常量。
- 新增 IPC handler 通过 `src/main/ipc-guard.ts` 的 `registerTrustedHandler` 注册，统一执行来源检查、输入与返回值 schema 校验及安全错误映射；取消等具有请求归属的操作还必须校验 owner，不得绕过公共守卫另建裸 handler。
- LLM API Key 不得发送到 Renderer 或写入日志；错误诊断日志在写入前必须对可能出现的密钥脱敏。
- Renderer 仅接收业务展示所需、经明确协议校验的最小数据，例如会话消息、已记录词条和练习结果；不得接收学习记忆正文与证据、完整 Agent 内部状态、内部工具载荷或失败请求诊断原文。仅限错误诊断场景，可将失败请求的必要用户数据与模型原始响应写入由 Main 维护的本地日志，写入前必须脱敏；该日志不得转发到 Renderer 或控制台。
- 对真实用户数据库执行迁移或变更持久化用户数据前，必须先询问用户，再根据用户意见决定是否执行。编写迁移代码、使用可丢弃的临时数据库测试本身不要求提前确认，但不得因此打开或升级真实用户数据库；开发启动或验证命令也不能绕过这一要求。
- 流式对话需要支持完成、失败和取消状态，避免 UI 永久停留在生成中。
- 错误应在产生处保留原因，在进程边界转换为对用户安全、可理解的错误结构。
- 新增 Agent 能力时，任务识别、Prompt、工具决策及执行流程统一扩展 `agent-engine/`；领域校验、模型传输、权限与仓储接口扩展 `src/core`，由 Main 装配并通过 Preload 接入 UI。不得新增 TS Agent 直跑或回退分支。
- 完成 `docs/plans/` 下某份 plan 文档中的全部计划工作及相关验证后，必须将该文档的状态更新为“已实施”；若文档尚无状态字段，则补充 `状态：已实施`。

### 测试驱动开发

- 新增或修改核心业务逻辑、状态流转、IPC 校验及安全边界时，默认采用 TDD：每次围绕一个可观察行为，先写测试并确认其因预期原因失败，再实现使其通过，最后在测试保持通过的前提下重构。
- 修复可自动复现的 Bug 时，先添加失败的回归测试，再修复。
- 测试应通过公开接口验证行为，避免绑定私有实现细节；涉及 LLM 时使用可控替身验证应用逻辑，不依赖真实模型输出。
- 不改变行为的重构优先复用现有测试；覆盖不足时先补充行为测试。
- 纯样式、文案、文档及探索性原型不强制 TDD。其他不适合测试先行的情况，应说明原因和替代验证方式。
- 完成后运行相关测试；按影响范围运行 `pnpm test`。涉及 Electron 端到端行为时，须遵循下述 E2E 测试许可规则。
- 执行任何 E2E（端到端）测试前，必须先询问用户，并取得明确许可后才能执行；此规则适用于 `pnpm test:electron` 及其他直接或间接启动 E2E 测试的命令，不得通过其他命令绕过许可要求。用户不允许执行或尚未明确许可时，不执行 E2E 测试，默认 E2E 没有问题，不将未执行 E2E 视为阻塞项；交付时应如实注明“E2E 未执行，按约定默认无问题”，不得表述为已执行或测试通过。

### 测试文件组织

- 单元测试和组件测试放在被测模块下的 `__tests__/` 目录中，不与生产源码文件平铺在同一目录。
- TypeScript 测试文件统一使用 `*.test.ts` 或 `*.test.tsx` 命名；Python 测试放在 `agent-engine/src/lingo_agent/__tests__/`，使用 `test_*.py` 命名，遵循 `agent-engine/pyproject.toml` 的 pytest 发现规则。
- 跨模块集成测试放在根目录 `tests/integration/`，端到端测试放在 `tests/e2e/`。
- 测试专用 fixtures、mocks 和辅助函数放在对应测试目录内；生产代码不得依赖测试目录中的内容。
- 移动测试文件时，同步更新导入路径和相关测试配置，确保测试仍能被发现并执行。

### 国际化与 Prompt 输出语言

- 所有面向用户的静态文本都必须进行国际化封装，通过统一的 i18n 翻译 key 和语言资源获取，不得在组件或业务代码中硬编码。范围包括页面文案、按钮、占位符、菜单、通知、错误提示、空状态和无障碍标签等，覆盖 Renderer 和 Electron 原生界面。
- 新增或修改静态文本时，应同步更新项目支持的各语言资源；包含动态值的文案使用国际化插值和复数规则，避免拼接可翻译文本。
- 每次使用 Prompt 时，都必须在实际发送给模型的指令中明确指定返回文本使用的语言，不得仅依赖 Prompt 本身的语言或让模型自行推断。输出语言应根据用户语言设置和当前学习任务显式传入。
- 同一响应需要使用多种语言时，必须分别标明各部分或字段的语言，例如“解释使用简体中文，例句使用英语”；结构化输出也必须明确自然语言字段的语言，并保持协议字段名和枚举值稳定。

## 验证命令

完成修改后，根据改动范围运行：

首次准备环境或 Python 锁文件变更后先运行 `pnpm agent:sync`。TypeScript 全量测试包含启动真实 Python 管道的集成测试，执行 `pnpm test` 前也必须确保锁定的 Python 环境已同步，不能因缺少环境而跳过这些测试。

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

涉及 Python、跨语言协议或宿主集成变更时，额外运行：

```bash
pnpm agent:protocol
pnpm agent:test
pnpm agent:check
```

修改 Zod 协议后，先运行 `node --experimental-strip-types scripts/agent-protocol-schema.mjs` 更新生成的 JSON Schema，再执行 `pnpm agent:protocol` 检查同步状态，并运行相关 TypeScript 与真实 Python 管道集成测试。

涉及 Python 运行包、启动或分发变更时，还需运行：

```bash
pnpm agent:build
pnpm agent:smoke
```

PyInstaller 运行包必须在目标 OS/CPU 原生构建；安装布局验证及跨平台验收步骤见 `agent-engine/README.md`，不能以单机检查通过代替其他平台验收。

涉及 Electron 端到端行为时，先询问用户并取得明确许可，再运行（未获许可时按上述 E2E 测试许可规则处理）：

```bash
pnpm test:electron
```

开发调试使用：

```bash
pnpm dev
```

涉及核心逻辑时应补充单元测试；涉及 Renderer 交互时应补充组件测试或 Playwright 测试。不要为了通过测试而削弱类型、输入校验或进程隔离。
