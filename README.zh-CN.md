# Lingo Mate

[English](README.md) | 简体中文

Lingo Mate 是一款桌面端 AI 语言学习助手。遇到不熟悉的表达，可以直接提问，把想记住的词汇和语句收进自己的学习库，再用积累的词汇做练习。学习记录保存在本地，模型服务由你选择。

**当前的目标学习语言是英语**，界面支持**简体中文和英语**。更多语种的适配方向见[语言学习定位与设计原则](docs/language-learning-scope.md)。

## 一次学习流程

1. **直接提问。** 在桌面会话里问「`keep me posted` 在什么场合用？」Agent 可以识别这类词义或用法问题，结合语境讲解。也可以输入 `/concept keep me posted`，明确选择概念讲解。
2. **收藏想复习的表达。** 发送 `/phrase keep me posted`，把短语连同解释和例句保存下来。发送 `/sentence 如果计划有变，记得告诉我。`，将原文翻成自然的英语，并一并收藏原文和译文。打开「已记录词汇」下的「短语」或「语句」即可查看。
3. **用自己的词库练习。** 用 `/vocabulary keep, update, change` 收录几个单词，再打开「开始练习」。可以回忆词义，也可以用系统从词库抽出的三个单词造句，获得短语提示，以及对用词、流畅度和语法的点评。
4. **回顾错题。** 词汇练习中答错的条目会自动收进「错题集」。

桌面会话支持查看历史、流式回复、取消生成和手动重试。

## 开始使用

### 从源码运行

准备 **Node.js 22.x（至少 22.12）**、**pnpm 10 或更新版本**和 **uv**。Agent Engine 使用锁定的 Python 3.13.3，由 `uv` 创建项目环境。

在仓库根目录执行：

```sh
pnpm install
pnpm agent:sync
pnpm dev
```

<details>
<summary>安装注意事项</summary>

- nvm 和 fnm 可通过 `.nvmrc` 选择 Node 22。若安装后缺少 `node_modules/electron/path.txt`，请在 Node 22 环境执行 `pnpm rebuild electron`。
- Electron 和 esbuild 等依赖的构建脚本批准配置见 [pnpm-workspace.yaml](pnpm-workspace.yaml)。
- 若 Electron 下载缓慢，可在 `~/.npmrc` 配置 `electron_mirror`。

</details>

Agent 运行时已在 **macOS arm64** 上验证。Windows、Linux、其他 CPU 架构和正式发行签名仍需分别验证。详见 [Agent Engine 指南](agent-engine/README.md)。

### 配置模型

1. 打开「设置 → 模型 → 新增模型」。
2. 选择「OpenAI 兼容」或「Gemini」，填写服务的 Base URL（含所需的版本路径）、Model ID，以及服务要求的 API Key。
3. 使用「测试草稿」，保存配置，并将它选为「当前使用模型」。
4. 新建会话，尝试上面的学习示例。

远程端点使用 HTTPS，`localhost` 等回环地址可以使用 HTTP。「测试草稿」会发送一条最小文本请求。词汇与短语分析、探索、近义词分析和词汇练习批改还要求模型支持工具调用（tool calling）。模型请求可能产生服务费用，可在「设置 → 用量」查看应用记录的请求数和服务商返回的 token 用量。

### 启用本地语音

在「设置 → 语音」安装约 **327 MB** 的语音资源后，可以朗读已保存的词汇、短语和英文例句，也可以用 `/tts` 生成可在会话中重播的音频。语音合成在本地完成，独立于模型服务。详见[语音运行时说明](docs/speech-runtime.md)。

## 桌面会话命令

可以在会话里直接输入命令，也可以从 `/` 菜单选择操作。想把某项内容加入学习库时，使用对应的收录命令。

| 命令示例                                     | 用途                                                         |
| -------------------------------------------- | ------------------------------------------------------------ |
| `/concept keep me posted`                    | 在会话中讲解词语或表达的核心含义和用法。                     |
| `/vocabulary keep, update, change`           | 分析并收录词汇，附上释义、核心概念和例句。                   |
| `/phrase break the ice`                      | 分析并收录短语或习语。批量输入时每行一个短语。               |
| `/synonym adequate, decent`                  | 分析并收录近义词组，比较含义和用法。                         |
| `/sentence I look forward to hear from you.` | 润色英文或将整段文字翻译成英文，并保存原文和润色结果或译文。 |
| `/explore-vocabulary`                        | 发现 10 个英语单词，附释义和例句。                           |
| `/explore-phrase`                            | 发现 10 个英语短语，附释义和例句。                           |
| `/tts Please keep me posted.`                | 在本地合成英语语音，可从会话中重播。                         |

两种探索命令各自与最近七批记录查重。在「已记录词汇 → 词汇」中，还可以通过 Excel 模板导入词条，或导出自己的词库。

## Telegram 和 QQ 私聊

桌面应用保持运行时，可以通过已绑定的 Telegram 或 QQ 机器人进行文本对话，或用 `/sentence` 收录语句。在私聊中发送 `/help` 可查看可用命令。

1. 在「设置 → 通信渠道 → 添加渠道」填写 Telegram Bot Token，或 QQ 机器人的 AppID 和 AppSecret。使用 QQ 时，需在 QQ 开放平台启用 WebSocket 和单聊权限。
2. 测试连接并启动渠道。若卡片上没有绑定码，先生成一个，再复制绑定命令。
3. 在机器人私聊中发送 `/bind <绑定码>`，回到桌面应用确认账号。

渠道集成已使用模拟平台连接验证，真实平台验收待完成。详见[通信渠道说明](docs/communication-adapters.md)。

## 数据与隐私

- **本地记录。** 会话、已保存的学习条目、词汇错题和会话音频保存在本地 SQLite，模型设置和探索历史保存在本地文件中。
- **外部服务。** AI 功能会将任务所需的输入和上下文发送到你配置的模型端点。启用通信渠道后，机器人消息经 Telegram 或 QQ 平台收发。首次安装语音资源时会从 Hugging Face 下载模型文件。
- **凭据。** 保存的模型 API Key 和机器人凭据通过 Electron `safeStorage` 加密。
- **诊断日志。** 本地错误日志会对凭据脱敏，诊断内容可能包含学习文本或模型原始回复。分享前请检查日志内容，详见[日志说明](docs/error-logging.md)。

## 开发指南

### 架构

```text
React UI → Preload API → Electron Main → TypeScript 宿主 / SQLite
                                      ↔ Python / LangGraph
```

Python/LangGraph Agent Engine 负责会话请求的路由，以及普通对话、桌面命令、标题生成、造句练习和词汇练习批改的 Prompt 与流程编排。TypeScript 宿主负责模型请求、凭据、校验、存储、语音和机器人连接。

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

每个打包命令都会附带原生 PyInstaller 运行包，安装后可直接运行。若只构建 TypeScript 应用，可执行 `pnpm build`。安装布局检查、签名要求和平台范围见 [Agent Engine 指南](agent-engine/README.md)。

## 参与贡献

欢迎通过本仓库的 Issues 和 Pull Requests 提交 Bug、功能建议、文档改进及范围明确的代码修改。

- 报告 Bug 时，请提供操作系统与 CPU、应用版本或提交号、复现步骤、预期行为和实际行为。附件中请移除凭据与私人学习内容。
- 较大改动建议先通过 Issue 说明预期行为，再开始实现。
- 阅读 [AGENTS.md](AGENTS.md)，遵循架构边界、国际化、测试和代码组织约定。新增 Agent 策略与工作流统一放在 `agent-engine/`。
- 可复现的 Bug 应补充回归测试；业务逻辑、状态流转及安全边界默认采用测试驱动开发。运行与改动相关的检查，并在 Pull Request 中说明结果。
- 验证时使用可丢弃数据。迁移或修改真实用户数据库前，以及执行任何 E2E 测试前，必须取得用户明确许可。

## 许可证

项目许可证待确定。第三方语音资源的许可声明见 [NOTICE.txt](resources/speech/headtts/NOTICE.txt)。
