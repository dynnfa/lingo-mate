# Lingo Mate

[English](README.md) | 简体中文

一款桌面端语言学习助手，将 AI 对话、词汇与表达积累、练习和错题回顾连接起来。Lingo Mate 面向不同母语的学习者，目标是帮助用户学习自己选择的语言。学习记录保存在本地，你可以连接自己的模型服务，并查看 token 用量。

Lingo Mate 帮助你把收集的内容变成可以练习的材料。已保存的分析可重复使用，重复词条会被跳过，练习题目从本地词库抽取，以减少不必要的模型调用。

## 核心功能

产品方向是通用语言学习助手。**当前版本的目标学习语言仅支持英语**，界面支持 **简体中文和英语**。新增学习语言需要适配 Prompt、校验、存储、练习和语音；切换界面语言不会增加学习语言支持。具体边界见[语言学习定位与设计原则](docs/language-learning-scope.md)。

- **通过对话学习。** 询问语言问题、润色句子，或使用 `/concept` 讲解概念。支持会话历史、流式回复、取消和手动重试。
- **建立个人学习库。** 使用 `/vocabulary` 保存词汇，使用 `/phrase` 保存短语，积累解释和例句；通过 `/synonym` 比较近义词及其用法。
- **发现新内容。** `/explore-vocabulary` 和 `/explore-phrase` 每次各生成十项内容，包含释义和例句。两种功能分别与各自最近七批历史查重，减少重复。
- **练习积累的内容。** 通过词汇练习回忆释义，自动收集错题；句子练习随机抽取三个已保存单词，提供短语提示，并点评用词、流畅度和语法。
- **本地朗读。** 朗读已保存的词汇、短语和英文例句，或使用 `/tts` 在会话中生成语音。支持暂停、继续、停止和时间跳转。
- **词汇导入与导出。** 批量分析新单词，使用 Excel 模板导入已有材料，并导出词库。导入时检测重复内容。
- **自选模型，查看用量。** 保存并切换多个 OpenAI-compatible 或 Gemini 配置；在服务返回用量数据时，查看 token 数、请求数及按天和按周的趋势。

## 一次学习流程

以下英语示例用于演示当前版本可用的学习流程。

1. 从问题或概念开始，例如发送 `/concept present perfect`。
2. 保存想学的单词：`/vocabulary adapt, adopt, adept`。
3. 打开「已记录词汇」，查看释义和例句。
4. 打开「开始练习」，进行词汇练习或句子练习。
5. 回到「错题本」，复习答错的词汇释义。

也可以使用 `/phrase break the ice` 保存短语，或通过 `/explore-phrase` 发现一批新短语。

## 开始使用

目前请按下方步骤从源码运行。本 README 暂未提供预构建安装包下载入口。

### 从源码运行

请先安装以下依赖：

- **Node.js 22.12+**（推荐 22.x 系列）：满足当前 Vite / Electron Vite 工具链要求，详见下方[安装注意事项](#安装注意事项)。
- **pnpm（10 及以上）**：管理 JavaScript 依赖。
- **uv**：管理 Python 环境。
- **Python 3.13.3**：版本固定在 `agent-engine/.python-version`，项目环境由 `uv` 管理。

在仓库根目录执行：

```sh
pnpm install
pnpm agent:sync
pnpm dev
```

#### 安装注意事项

- **优先使用 Node 22（22.12+）。** 该版本是本工具链的验证基线，`.nvmrc` 已固定，供 nvm/fnm 用户自动切换。Node 24.16+/26.1+ 的核心流行为变化会使 `yauzl@2`（Electron 二进制安装器依赖）在解压中途停滞：`pnpm install` 结束时没有 Electron 二进制，随后 `pnpm dev` 报 `Error: Electron uninstall`。`pnpm-workspace.yaml` 中的 `yauzl` override 已修复这些版本上的安装器（已在 Node 26 验证）；其余工具链环节仍只在 Node 22 上验证。
- **依赖构建脚本的批准位置在 `pnpm-workspace.yaml`。** pnpm 10 及以上不再读取 `package.json` 的 `pnpm` 字段。`electron` 和 `esbuild` 需要执行安装脚本；它们的批准（以及对自带预编译产物包的显式拒绝）都在该文件中声明。新增带构建脚本的依赖时请同步更新该文件。
- **安装完成后校验 Electron 二进制。** `node_modules/electron/path.txt` 应当存在；若缺失，请在 Node 22 环境下执行 `pnpm rebuild electron`。
- **下载缓慢或被阻断。** 若 Electron 二进制下载缓慢，可在 `~/.npmrc` 配置镜像，例如 `electron_mirror=https://npmmirror.com/mirrors/electron/`。

开发启动会使用持久化的应用数据。验证改动时请使用独立的测试用户数据目录，参见下方的[贡献说明](#参与贡献)。

### 配置模型

1. 打开「设置 → 模型 → 添加模型」。
2. 选择 API 类型，填写服务的 Base URL、Model ID，以及服务要求的 API Key。
3. 使用「测试草稿」，保存配置，并将它选为「当前使用模型」。
4. 新建会话，尝试上面的学习示例。

| 配置项   | 填写内容                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| API 类型 | 根据服务协议选择 `OpenAI-compatible` 或 `Gemini`                                                             |
| Base URL | 服务提供的 API 根地址，包含所需的版本路径；例如 `https://api.example.com/v1` 仅为 OpenAI-compatible 地址示意 |
| Model ID | 该端点实际接受的模型标识                                                                                     |
| API Key  | 服务凭据；不需要身份验证的本地端点可以留空                                                                   |

远程端点必须使用 HTTPS；`localhost` 等回环地址允许使用 HTTP。模型在应用内配置，无需创建 `.env` 文件。

词汇与短语分析、探索、近义词比较、词汇练习批改需要模型支持工具调用（tool/function calling）。连接测试成功只说明最小文本请求可用，不代表全部学习流程都兼容；兼容性取决于端点与所选模型。

模型请求（含连接测试）可能产生由所选服务收取的费用。用量统计依赖服务返回的数据，不是账单。

### 启用本地语音

在「设置 → 语音」安装约 **327 MB** 的语音资源。安装完成后，语音合成在本地运行，无需配置大语言模型。资源详情和验证范围见[语音运行时说明](docs/speech-runtime.md)。

### 平台状态

仓库包含 macOS、Windows 和 Linux 的打包命令。目前文档记录的运行时验证平台为 **macOS arm64**；其他操作系统、CPU 架构及正式发行签名仍需在对应发布环境验证。存在打包配置不代表已完成平台支持验收，具体范围见 [Agent Engine 指南](agent-engine/README.md)。

## 数据与隐私

- **本地记录：** 会话、已保存学习条目、词汇错题及会话音频保存在本地 SQLite。模型设置和探索历史分别保存在应用用户数据目录下的本地文件中。
- **模型请求：** AI 功能会将执行任务所需的输入与上下文发送到你配置的端点，例如会话历史、词汇或练习答案。本地保存不代表这些请求离线执行；端点如何处理数据取决于所选服务。
- **凭据：** 保存的 API Key 通过 Electron `safeStorage` 加密，界面获取的是掩码预览，而非已保存的明文密钥。
- **语音资源：** 首次安装从 Hugging Face 下载模型资源，后续语音合成在本地执行。
- **诊断日志：** 本地错误日志会对凭据脱敏，但失败诊断可能包含学习文本或模型原始回复。分享前请检查日志内容，详见[日志说明](docs/error-logging.md)。

## 开发指南

### 架构

```text
React UI → Preload API → Electron Main → TypeScript 宿主 / SQLite
                                      ↔ Python / LangGraph
```

Python 负责对话、标题、词汇、短语、近义词、探索、句子练习、词汇练习批改及 `/tts` 的 Agent 任务识别、Prompt 和流程编排。TypeScript 负责模型传输、凭据、领域校验、持久化与桌面能力。引擎故障会明确报错，不静默回退或自动重放请求。

实现细节见[界面架构说明](docs/architecture.md)、[Agent Engine 指南](agent-engine/README.md)和[项目开发约定](AGENTS.md)。

### 验证

运行 TypeScript 全量测试前，请先同步锁定的 Python 环境；其中包含启动真实 Python 管道的集成测试：

```sh
pnpm agent:sync
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

涉及 Python、协议或宿主集成变更时，还需运行：

```sh
pnpm agent:protocol
pnpm agent:test
pnpm agent:check
```

协议变更须遵循 [Agent Engine 指南](agent-engine/README.md)中的 schema 生成步骤。运行包相关变更还需执行 `pnpm agent:build` 和 `pnpm agent:smoke`。

按项目约定，执行 Electron E2E 前必须取得用户明确许可。获许可后可执行 `pnpm test:electron`，该命令会先构建桌面代码和 Python 运行包。语音验证另有资源要求，见[语音运行时说明](docs/speech-runtime.md)。

### 打包

完成 `pnpm agent:sync` 后，在目标操作系统与 CPU 架构的原生环境运行相应命令：

```sh
pnpm build:mac
pnpm build:win
pnpm build:linux
```

这些命令都会构建原生 PyInstaller 运行包。打包后的应用不要求用户安装 Python 或 uv。单独运行 `pnpm build` 只构建 TypeScript 应用，不生成 Python 运行包或安装程序。安装布局检查、签名要求与平台限制见 [Agent Engine 指南](agent-engine/README.md)。

## 参与贡献

欢迎通过本仓库的 Issues 和 Pull Requests 提交 Bug、功能建议、文档改进及范围明确的代码修改。

- 报告 Bug 时，请提供操作系统与 CPU、应用版本或提交号、复现步骤、预期行为和实际行为。附件中请移除凭据与私人学习内容。
- 较大改动建议先通过 Issue 说明预期行为，再开始实现。
- 阅读 [AGENTS.md](AGENTS.md)，遵循架构边界、国际化、测试和代码组织约定。新增 Agent 策略与工作流统一放在 `agent-engine/`。
- 可复现的 Bug 应补充回归测试；业务逻辑、状态流转及安全边界默认采用测试驱动开发。运行与改动相关的检查，并在 Pull Request 中说明结果。
- 验证时使用可丢弃数据。迁移或修改真实用户数据库前，以及执行任何 E2E 测试前，必须取得用户明确许可。

## 许可证

项目许可证尚未确定，仓库目前没有项目级 `LICENSE` 文件，需在正式开源发布前补齐。第三方语音资源的许可声明单独记录在 [NOTICE.txt](resources/speech/headtts/NOTICE.txt)。
