# Lingo Mate Agent Engine

本模块是唯一 Agent 运行时，负责任务识别、Prompt、工具决策与内存中的 LangGraph 编排。会话与消息持久化、语言学习规则、模型凭据、供应商请求和用量统计均由 TypeScript 宿主负责。生产接入普通对话、`/concept`、`/vocabulary` 与 `/phrase`；模型决策/只读工具循环通过测试扩展验证。无 checkpoint、业务数据库访问、云端 tracing 或模型 SDK 请求。

决策与限制见 [ADR](../docs/adr/2026-10-21-python-langgraph-agent-engine.md)。本文命令与文件路径均以仓库根目录为基准。协议源位于 `src/core/agent/agent-protocol.ts`；生成的 `agent-engine/src/lingo_agent/protocol/schema.json` 随包发布，不能手改。共享契约样例在 `tests/integration/fixtures/agent/protocol-cases.json`。

## 开发

从仓库根目录运行，需要 pnpm、Node 22.6+、uv 和锁定的 Python 3.13.3：

```sh
pnpm agent:sync
pnpm agent:protocol
pnpm agent:test
pnpm agent:check
pnpm dev
```

普通对话、`/concept`、`/vocabulary` 与 `/phrase` 默认且始终经过 Python（包括本地模拟模型），无需运行时参数。子进程在首次 Agent 请求时启动；启动/协议/执行故障不会回退或自动重放失败请求。`LINGO_MATE_AGENT_BUNDLE=1` 仅用于开发时选择冻结运行包。开发解释器只从 `agent-engine/.venv/bin/python`（Windows `agent-engine/.venv/Scripts/python.exe`）启动，不搜索 PATH。手动入口为 `agent-engine/.venv/bin/python -I -m lingo_agent`，Windows 使用对应解释器路径，只接受 JSONL 管道协议。

所有检查与测试均使用锁定环境。Python 测试在 `agent-engine/src/lingo_agent/__tests__/test_*.py`，pytest 发现规则由 `agent-engine/pyproject.toml` 配置。执行 TypeScript 全量测试前也要完成 `agent:sync`；新增进程集成测试确实启动 Python，不会在缺环境时悄悄跳过。测试仅使用可控替身/本地假模型服务。

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm agent:build
pnpm agent:smoke
pnpm test:electron
```

## 打包与安装目录验证

```sh
pnpm agent:build
pnpm agent:smoke
pnpm build:unpack
```

`build:unpack`、`build:mac`、`build:win` 和 `build:linux` 均先构建原生运行包。PyInstaller 必须在目标 OS/CPU 原生构建；不能通过指定 electron-builder 架构来交叉编译 Python。原始目录在 `agent-engine/dist/<platform>-<arch>/lingo-agent/`，归档位于 `agent-engine/dist/lingo-agent-<platform>-<arch>.tar.gz`，保存执行权限及符号链接。下载 CI 产物后先解压到相应架构目录，再用于桌面打包。生成物全部忽略，不提交仓库。

electron-builder 复制该目录至 `resources/agent-engine/`，置于 ASAR 外。manifest 中应用版本、协议、OS 与 CPU 任一不匹配都会安全拒绝启动。应用启动不安装依赖，也不读取 Renderer 指定的命令、路径或环境。

`agent:smoke` 从独立临时工作目录、空 PATH、无虚拟环境变量启动冻结可执行文件，验证握手→流式任务→20 词双并发图→20 短语双并发图→取消→迟到结果→崩溃→重启→带活动任务退出，并输出包体积、耗时与可测的资源数据。Windows 的资源指标为空；不代表占用为零。

`tests/e2e/python-agent.test.ts` 默认覆盖开发解释器和冻结运行包。构建 `electron-builder --dir` 后，显式设置 `LINGO_MATE_TEST_PACKAGED=1` 再运行该测试，还会启动安装布局中的应用，检查 `app.isPackaged` 路径。生产设置不提供运行时切换页面。

```sh
LINGO_MATE_TEST_PACKAGED=1 pnpm exec playwright test tests/e2e/python-agent.test.ts
```

CI 为 macOS arm64/x64、Linux arm64/x64、Windows arm64/x64 配置原生 Python 检查、真实管道集成、生产包烟测、桌面目录构建及 Electron 默认运行时测试。CI 配置见 `.github/workflows/agent-engine.yml`；配置存在不等于对应平台通过。

macOS 本地包使用 PyInstaller 的 ad-hoc 签名。正式发行还需原有 Apple Developer ID、嵌套二进制签名与 notarization 验收；本仓库未配置发行证书，本次未改变 `notarize: false`。Windows 正式发行签名亦需发布环境验证。

## 协议演进与排错

当前协议为 v4。应用提交 `conversation`、`vocabulary` 或 `phrase` 任务，`/concept` 在 Python 内部识别。`model.reply` 必须提供完整 `systemPrompt`，TS 模型适配器原样发送，不再选择 Agent Prompt。Prompt 上限为 4096 个 UTF-16 单元，两端校验实际 Prompt 加历史的总输入预算；旧运行包必须重建。除词汇和短语外的显式技能、标题及练习暂沿用 TS 实现，未来新增 Agent 策略和工作流统一在本模块实现。

- 修改 Zod 协议后运行 `node --experimental-strip-types scripts/agent-protocol-schema.mjs`，更新共享用例；破坏性修改提升协议版本并重建全部运行包。
- stdout 专用于协议，Python 不输出用户错误文案或 traceback。stderr 只由 Main 有界接收并进入已有本地错误日志。
- `AGENT_UNAVAILABLE`：检查 `agent-engine/.venv` 或安装资源完整性、manifest、执行权限及启动次数上限。只对后续新请求重启，不重放失败任务。
- `AGENT_PROTOCOL_ERROR`：检查应用与运行包是否匹配、帧格式/大小、身份、call ID 或事件序号。内部工具参数、状态及模型原始响应不会进入 UI。
- `AGENT_LIMIT`：输入副本、输出、调用次数、图步数或总截止时间达到上限；完整存储历史保留。
- 取消是独立控制消息，但不能超越其运行的启动帧。1 秒内无终态确认会终止共享进程，其余在途请求也失败；后续新请求可重新启动。
- 退出先停止接单、取消执行和宿主模型，再结束 Python，最后关闭数据库及日志。没有新增会话恢复或写工具重试语义。

## 本地验收记录

2026-10-21，macOS arm64，CPython 3.13.3 / LangGraph 1.2.12 / PyInstaller 6.22.3：

- 冻结运行包空 PATH 烟测通过：流式、取消、迟到结果、崩溃、重启、正常退出。
- 原始目录大小 47,131,621 字节（约 45 MiB）；两次新构建的冷启动观测为 5409.1 / 14995.6 ms，重启为 297.5 / 321.2 ms。就绪截止时间为 30 秒。
- 就绪后 RSS 87,136–87,712 KiB（约 85–86 MiB）；随后 0.5 秒采样的空闲 CPU 为 0%。这些是本机有限次观测，不是性能承诺。
- TypeScript 全量、Python 静态/行为检查与 Electron 结果以最终 plan 实施记录为准。

尚未验收：其余 OS/CPU 的 CI 运行、正式签名/公证及干净机器安装。空 PATH 烟测证明独立运行包不依赖系统 Python，不能代替所有平台的完整安装验收。因此计划保留“实施中”状态。

## 参考

- [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api)
- [PyInstaller 目录式分发](https://pyinstaller.org/en/stable/operating-mode.html)
- [GitHub 原生 runner 架构](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

## Python 唯一运行时验收

2026-10-21 的 v2 变更已通过 macOS arm64 的开发解释器、冻结包和安装布局端到端验证，以及空 PATH 运行包烟测。完整结果与尚未执行的平台见 [Python 唯一运行时计划](../docs/plans/2026-10-21-python-only-agent-runtime.md)。此前性能数字保留为历史观测，不代表本次构建的性能承诺。

## 词汇 LangGraph 与协议 v3

`/vocabulary` 的 `prepare → analyze → finalize` 图位于 `graphs/vocabulary.py`，分析 Prompt 仅由 Python 生成。准备节点经 `vocabulary.prepare` 获取宿主规范化、查重后的必要词项；两个 worker 逐词调用 `model.vocabulary`，只传绑定索引及完整系统指令，最多 20 次，不自动重试。词汇不转发正文或思考片段，只返回严格校验的 `vocabulary_result` 完成标记。

TS 保留每个运行的原始词项、配置快照、校验后的学习内容与系统字段。每词 30 秒、分析窗口 120 秒，窗口到期后的未启动项返回 TIMEOUT 且不请求供应商；已有有效项可形成部分成功报告。总硬截止 180 秒包含启动。词汇最多 20 次模型调用、2 次工具调用、32 步；对话默认预算不变。宿主按实际 Prompt、绑定词项 JSON 与工具定义核对输入预算，Python 使用逐词输入与工具预留做有界检查；输出预算仅计跨协议安全回执，不传输学习内容。

宿主在图终态核验完成索引完整且无重复后，进入 committing 阶段，最后检查取消并执行同步事务，词条和批次报告原子落盘。引擎故障、越权、非法索引、重复词项分析或过量并发会明确失败并取消同运行的其余请求，不触及词库；取消后不接收迟到结果。已提交报告但回复保存失败时，仅本地恢复回复。AI 导入逐词通过同一 Python 图取得 Prompt，保留原有导入工作流。

协议 v3 同步扩展能力握手、任务、宿主调用和结构化终态；v1/v2 运行包均不兼容。生成 schema 后不要单独格式化 JSON 生成物，否则会触发 `agent:protocol` 的逐字同步检查。词汇端到端验收及尚未验收的平台见 [词汇迁移计划](../docs/plans/2026-10-21-vocabulary-langgraph-agent.md)。

2026-10-21 的 v3 词汇迁移已完成 macOS arm64 的开发解释器、冻结包、真实管道、Electron 词汇及 AI 导入验收，空 PATH 烟测新增 20 词双并发图。最终测试结果及本次未执行的安装布局、其他平台验收见 [词汇迁移计划](../docs/plans/2026-10-21-vocabulary-langgraph-agent.md)。

## 短语 LangGraph 与协议 v4

`/phrase` 的图位于 `graphs/phrase.py`，采用 `prepare → analyze → finalize`。`phrase.prepare` 返回规范化、查重后的必要短语；两个 worker 逐项调用 `model.phrase`，参数仅含绑定索引与 Python 生成的完整系统指令。已有项和重复项不请求模型，单项结果通过安全回执返回，图最终发送 `phrase_result` 完成索引。

短语和词汇使用独立任务权限，同一进程中的每个批次最多两个同领域模型调用，其他任务仍只允许一个在途宿主调用。每批最多 20 项、单项 30 秒、分析窗口 120 秒、含启动的硬截止 180 秒；模型／工具／步数预算为 20／2／32。Prompt 上限 4096 个 UTF-16 单元，宿主核对实际 Prompt、绑定短语 JSON 与工具定义的总输入。

TS 宿主账本保留原始输入、规范化身份、配置快照和校验后的内容。完整核验图完成索引后，才在同步短事务内写入短语和报告。取消、引擎故障或非法协议在提交前丢弃暂存内容；已提交报告的回复恢复不调用图或模型。Prompt 保留 `phrase-tools-v1` 语义，`explantation` 字段不变；不增加数据库迁移、自然语言识别、自动重试或回退。

协议 v4 同步扩展任务、握手、调用和终态，v1/v2/v3 运行包均不兼容，必须随应用重建。空 PATH 烟测覆盖 20 项短语图；完整验证结果见 [短语迁移计划](../docs/plans/2026-10-21-phrase-langgraph-agent.md)。

2026-10-21 的 v4 短语迁移已完成 macOS arm64 开发解释器、真实管道、冻结运行包与 Electron 全套验收。空 PATH 烟测覆盖词汇和短语各 20 项双并发图；最终测试结果、安装布局跳过项及其他平台边界见 [短语迁移计划](../docs/plans/2026-10-21-phrase-langgraph-agent.md)。
