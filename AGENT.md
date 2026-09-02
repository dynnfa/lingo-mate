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
├── main/       # Electron 主进程
├── preload/    # 主进程与 Renderer 之间的安全桥接层
├── renderer/   # React 用户界面
└── core/       # Agent Engine 核心逻辑
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

不要直接向 Renderer 暴露 `ipcRenderer`、Node.js 模块、文件系统或其他高权限对象。新增桥接 API 时，应同步更新 `src/preload/index.ts` 和 `src/preload/index.d.ts`。

### `src/renderer`

负责 React 用户界面，包括：

- 页面、组件和路由
- UI 状态与交互逻辑
- 展示对话、学习内容、Agent 状态与错误信息
- 通过 `window.api` 调用 preload 提供的能力

Renderer 视为浏览器环境，不得直接导入 Electron 主进程模块、Node.js API 或 `src/core`。业务规则应下沉到 Agent Engine，不要隐藏在 React 组件中。

### `src/core`

负责与界面无关的 Agent Engine 和语言学习业务逻辑。建议按领域拆分，例如：

```text
src/core/
├── agent/          # Agent 调度、工具调用和执行循环
├── conversation/   # 会话模型、消息流和上下文组装
├── llm/            # 模型客户端、提示词和流式响应
└── memory/         # 短期/长期记忆、检索与持久化
```

核心逻辑应尽量通过明确接口与依赖注入连接 LLM、存储和系统能力，以便独立测试。不要从 `src/core` 导入 React 组件或 Renderer 状态。

## 依赖方向

依赖应保持单向：

```text
React Renderer -> Preload API -> Electron Main -> Agent Engine
                                            -> OS / storage / network
```

- Renderer 只能通过 preload 暴露的 API 请求高权限能力。
- Preload 只定义安全边界和数据传输，不实现业务逻辑。
- Main 负责调用、生命周期和进程间编排。
- Core 保存可复用、可测试的领域逻辑，不依赖 UI。
- 跨边界传输的数据必须可序列化，并使用明确的 TypeScript 类型；外部输入应使用 Zod 等方式校验。

## 开发约定

- 使用 TypeScript，避免无必要的 `any` 和 `@ts-ignore`。
- 保持模块职责单一；组件、IPC handler 和 Agent 工具不应承担多个领域职责。
- IPC channel 使用稳定、可读的领域命名，并集中定义，避免散落的字符串常量。
- LLM API Key、用户数据和学习记忆不得发送到 Renderer 或写入日志。
- 流式对话需要支持完成、失败和取消状态，避免 UI 永久停留在生成中。
- 错误应在产生处保留原因，在进程边界转换为对用户安全、可理解的错误结构。
- 新增 Agent 能力时，优先扩展 `src/core`，再通过 Main 和 Preload 接入 UI。

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
