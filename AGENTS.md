# Lingo Mate 项目指南

## 项目定位

Lingo Mate 是一个桌面端语言学习助手 Agent。它通过对话、记忆和大语言模型能力，为用户提供持续、个性化的语言学习体验。

技术栈为 Electron、React、TypeScript，并使用三层架构：

1. Electron 桌面运行层
2. React 用户界面层
3. Agent Engine 核心能力层

## 目录职责

```text
src/
├── main/           # Electron 主进程
├── preload/        # IPC Bridge，Renderer 与 Main 之间的安全桥接层
├── core/           # Agent Engine 核心逻辑
│   ├── agent/      # Agent 调度、执行循环与生命周期
│   ├── llm/        # 模型客户端、模型配置与流式响应
│   ├── memory/     # 短期/长期记忆与检索
│   ├── tools/      # Agent 工具定义与执行
│   ├── prompt/     # Prompt 模板、组装与版本管理
│   ├── learning/   # 语言学习领域逻辑
│   └── conversation/ # 会话模型、消息流与上下文组装
├── database/       # SQLite schema、迁移、连接与数据访问
├── shared/         # 跨层共享的 TypeScript 类型与协议
└── renderer/       # React 用户界面
```

### `src/main`

负责 Electron 主进程能力，包括：

- 应用生命周期与窗口管理
- 注册和处理 IPC 请求
- 调用操作系统、文件系统等 Node.js 能力
- 创建并协调 `src/core` 中的 Agent 服务

主进程只负责桌面应用编排，不应包含 React UI 或具体的学习业务逻辑。

### `src/preload`

负责主进程与网页 Renderer 之间的安全桥接，包括：

- 使用 `contextBridge` 暴露最小化、明确命名的 API
- 为暴露的 API 提供 TypeScript 类型声明
- 将 Renderer 请求转换为 IPC 调用

不要直接向 Renderer 暴露 `ipcRenderer`、Electron 原始 API、Node.js 模块、文件系统或其他高权限对象。preload 应暴露面向业务场景的窄接口，而不是通用的 `send`、`invoke` 或任意 channel 调用能力。新增桥接 API 时，应同步更新 `src/preload/index.ts` 和 `src/preload/index.d.ts`。

### `src/renderer`

负责 React 用户界面，包括：

- 页面、组件和路由
- UI 状态与交互逻辑
- 展示对话、学习内容、Agent 状态与错误信息
- 通过 `window.api` 调用 preload 提供的能力

Renderer 必须视为纯浏览器环境，不得直接导入或调用任何 Electron API，包括但不限于 `ipcRenderer`、`shell`、`webFrame`、`remote` 以及 Electron 主进程模块；也不得直接使用 Node.js API、访问文件系统、数据库或导入 `src/core`。

凡是需要 Electron、操作系统、文件系统、数据库或其他高权限能力的功能，都必须先在 Main 中实现受控处理，再通过 preload 使用 `contextBridge` 暴露为明确类型的 `window.api` 接口，由 Renderer 调用。不得通过开启 `nodeIntegration`、关闭 `contextIsolation` 或向 Renderer 暴露原始 IPC 对象来绕过该边界。

业务规则应下沉到 Agent Engine，不要隐藏在 React 组件中。

页面目录按 menu 组织：根目录只保留外层页面容器及其 `__tests__/`，每个 menu 使用独立子目录（如 `recorded/phrase/`、`settings/models/`），收拢该 menu 的组件、hooks 和辅助函数。menu 专属测试放在对应子目录的 `__tests__/` 中。跨 menu 或应用级公共能力按实际职责存放，不复制到各 menu，也不归入某个单独 menu。

### `src/core`

负责与界面无关的 Agent Engine 和语言学习业务逻辑，按以下领域拆分：

```text
src/core/
├── agent/          # Agent 调度、工具调用和执行循环
├── llm/            # 模型客户端、提示词和流式响应
├── memory/         # 短期/长期记忆与检索
├── tools/          # Agent 工具定义与执行
├── prompt/         # Prompt 模板、组装与版本管理
├── learning/       # 语言学习领域逻辑
└── conversation/   # 会话模型、消息流和上下文组装
```

核心逻辑应尽量通过明确接口与依赖注入连接 LLM、存储和系统能力，以便独立测试。不要从 `src/core` 导入 React 组件或 Renderer 状态。

### `src/database`

负责 SQLite 基础设施，包括 schema、迁移、数据库连接、事务和数据访问实现。数据库实现不得被 Renderer 直接导入或调用；应由 Main 或 Core 中定义的接口进行协调。

### `src/shared`

负责跨进程、跨层共享的 TypeScript 类型、IPC channel 常量和可序列化协议。该目录不得包含依赖 Electron、React、Node.js 运行时或具体业务执行逻辑的代码，避免共享类型反向引入高权限实现。

## 依赖方向

依赖应保持单向：

```text
React Renderer -> Preload API -> Electron Main -> Agent Engine
                                            -> Database / OS / network
```

- Renderer 只能通过 preload 暴露的 `window.api` 请求 Electron 及其他高权限能力，禁止直接调用 Electron API。
- Preload 只定义安全边界和数据传输，不实现业务逻辑。
- Main 负责调用、生命周期和进程间编排。
- Core 保存可复用、可测试的领域逻辑，不依赖 UI。
- Database 提供 SQLite 基础设施和数据访问实现，不依赖 Renderer。
- Shared 仅承载跨层类型与协议，不承载高权限实现或业务逻辑。
- 跨边界传输的数据必须可序列化，并使用明确的 TypeScript 类型；外部输入应使用 Zod 等方式校验。

## 开发约定

- 使用 TypeScript，避免无必要的 `any` 和 `@ts-ignore`。
- 保持模块职责单一；组件、IPC handler 和 Agent 工具不应承担多个领域职责。
- IPC channel 使用稳定、可读的领域命名，并集中定义，避免散落的字符串常量。
- LLM API Key、用户数据和学习记忆不得发送到 Renderer 或写入日志。
- 如果涉及数据库迁移或持久化数据变更，必须先询问用户，再根据用户意见决定是否执行迁移或变更操作。
- 流式对话需要支持完成、失败和取消状态，避免 UI 永久停留在生成中。
- 错误应在产生处保留原因，在进程边界转换为对用户安全、可理解的错误结构。
- 新增 Agent 能力时，优先扩展 `src/core`，再通过 Main 和 Preload 接入 UI。
- 完成 `docs/plans/` 下某份 plan 文档中的全部计划工作及相关验证后，必须将该文档的状态更新为“已实施”；若文档尚无状态字段，则补充 `状态：已实施`。

### 测试文件组织

- 单元测试和组件测试放在被测模块下的 `__tests__/` 目录中，不与生产源码文件平铺在同一目录。
- 测试文件统一使用 `*.test.ts` 或 `*.test.tsx` 命名。
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

```bash
pnpm lint
pnpm typecheck
pnpm build
```

开发调试使用：

```bash
pnpm dev
```

涉及核心逻辑时应补充单元测试；涉及 Renderer 交互时应补充组件测试或 Playwright 测试。不要为了通过测试而削弱类型、输入校验或进程隔离。
