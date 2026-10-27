# Lingo Mate Agent Engine

本模块是唯一 Agent 运行时，负责任务识别、Prompt、工具决策与内存中的 LangGraph 编排。会话与消息持久化、语言学习规则、模型凭据、供应商请求和用量统计均由 TypeScript 宿主负责。生产接入普通对话、`/concept`、`/vocabulary`、`/phrase`、`/synonym`、`/explore-phrase`、`/explore-vocabulary` 与句子练习（提示和点评）；模型决策/只读工具循环通过测试扩展验证。无 checkpoint、业务数据库访问、云端 tracing 或模型 SDK 请求。

架构边界与任务权限约定见 [AGENTS.md](../AGENTS.md)。本文命令与文件路径均以仓库根目录为基准。协议源位于 `src/core/agent/agent-protocol.ts`；生成的 `agent-engine/src/lingo_agent/protocol/schema.json` 随包发布，不能手改。共享契约样例在 `tests/integration/fixtures/agent/protocol-cases.json`。

## 开发

从仓库根目录运行，需要 pnpm、Node 22.6+、uv 和锁定的 Python 3.13.3：

```sh
pnpm agent:sync
pnpm agent:protocol
pnpm agent:test
pnpm agent:check
pnpm dev
```

普通对话、`/concept`、`/vocabulary`、`/phrase`、`/synonym`、`/explore-phrase`、`/explore-vocabulary` 与句子练习（提示和点评） 默认且始终经过 Python（包括本地模拟模型），无需运行时参数。子进程在首次 Agent 请求时启动；启动/协议/执行故障不会回退或自动重放失败请求。`LINGO_MATE_AGENT_BUNDLE=1` 仅用于开发时选择冻结运行包。开发解释器只从 `agent-engine/.venv/bin/python`（Windows `agent-engine/.venv/Scripts/python.exe`）启动，不搜索 PATH。手动入口为 `agent-engine/.venv/bin/python -I -m lingo_agent`，Windows 使用对应解释器路径，只接受 JSONL 管道协议。

所有检查与测试均使用锁定环境。Python 测试在 `agent-engine/src/lingo_agent/__tests__/test_*.py`，pytest 发现规则由 `agent-engine/pyproject.toml` 配置。执行 TypeScript 全量测试前也要完成 `agent:sync`；新增进程集成测试确实启动 Python，不会在缺环境时悄悄跳过。测试仅使用可控替身/本地假模型服务。

## 源码入口与工作流

以下目录相对于 `agent-engine/src/lingo_agent/`：

```text
lingo_agent/
├── __main__.py                 # JSONL 启动入口
├── runtime/
│   ├── server.py               # 协议、生命周期、完成帧与错误转换
│   └── dispatcher.py           # execute(run_id, snapshot, host)，显式按 task 分发
├── workflows/
│   ├── common.py              # 共享宿主边界检查、UTF-16 预算与回复辅助
│   ├── language.py            # Prompt 使用的语言名称
│   ├── conversation/
│   │   ├── routing.py         # 最新 user 消息的 /concept 识别及会话内选择
│   │   ├── graph.py           # 普通回复：START → reply → END
│   │   ├── concept.py         # 概念讲解：START → explain → END
│   │   ├── title.py           # 独立 conversation-title 任务
│   │   └── prompts.py         # 对话、概念与标题指令
│   ├── vocabulary/            # graph.py + prompts.py
│   ├── phrase/                # graph.py + prompts.py
│   ├── synonym/               # graph.py + prompts.py
│   ├── explore_phrase/        # graph.py + prompts.py
│   ├── explore_vocabulary/    # graph.py + prompts.py
│   ├── sentence_practice/     # graph.py + prompts.py，提示与点评共享图
│   ├── vocabulary_practice/   # graph.py + prompts.py，含补标指令
│   ├── tts.py                 # 确定性单节点图，无模型 Prompt
│   └── tool_loop.py           # 受控测试扩展的 decide ↔ tool 图
├── state/__init__.py          # 保留共享 LearningState；其他任务状态随图维护
├── protocol/                 # JSONL 解析及生成 schema
└── __tests__/                # 行为测试与迁移前固定 Prompt 输出
```

从 `runtime/dispatcher.py` 找到 task，再进入所属功能目录查看图、节点、局部状态和 Prompt。分发器使用静态导入，只选择入口；未知 task 在宿主调用前明确失败，由 Server 转为 `AGENT_PROTOCOL_ERROR`。`conversation` 经会话路由选择普通对话或概念图；`conversation-title` 独立分发。测试工具图仍需 TS 受控注入授权，目录归属不扩大生产权限。

Prompt 直接由所属图导入，各功能不互相注册或批量重导出。`__tests__/fixtures/prompt-baselines.json` 保存目录迁移前的 40 组固定输出，覆盖所有 Prompt、两种界面语言及独立学习语言；逐字比较包括空白、换行和补标指令。协议版本、任务预算与宿主提交边界保持不变。

## TypeScript 宿主任务边界

公开运行入口保持在 `AgentRuntime`，每次运行由 `src/core/agent/agent-task-binding.ts` 静态绑定一个任务及其依赖。批量任务只携带自己的领域 Host，对话与标题绑定当前运行的模型，`tool-loop` 必须显式安装测试扩展；未授权时在启动 Python 前失败。

- `agent-task-policy.ts` 集中固定权限、调用／字符预算、并发、流事件模式和预期成功帧。`createAgentSnapshot()` 复制策略并通过原有 Zod Schema 校验，只裁剪执行上下文副本。
- `agent-host.ts` 统一拒绝越权和重复调用、检查取消、预留步骤及模型／非模型调用预算、累计输出。Adapter 完成操作专属校验后才返回待执行调用，预算在任何实际调用及 `await` 前预留。
- `tasks/*-task.ts` 收拢各任务参数／回执 Schema、词项索引或练习顺序、实际输入检查、模型绑定及完成核验。近义词、探索与练习的领域账本仍由原有 Host 持有；Adapter 不执行持久化提交。
- Main 的 `PythonAgentRuntime` 仅按当前绑定策略接收调用与事件，管理身份、序号、在途调用、队列、截止和取消。所有成功帧必须匹配当前任务且不存在未完成调用，再由当前 Adapter 核验；重复与迟到帧不能再次释放结果。

输出保持原有 UTF-16 计量口径：对话按流增量、测试决策按最终正文、领域操作按安全回执 JSON 累计；词汇／短语准备结果与 TTS 回执保留原有不累计方式，流正文不按最终 `text` 再扣一次。词汇／短语各自只允许两个模型分析并行，准备调用与其他任务仍串行。统一终态准入补齐了其他任务提前成功的拒绝行为。

新增任务需显式扩展协议、可信策略、任务绑定、Adapter 和公开运行入口；通用调用与成功处理不增加领域分支。Python 图、Prompt、协议 v11 及原有领域提交、恢复和幂等边界均保持不变。

## 应用与运行包检查

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm agent:build
pnpm agent:smoke
pnpm test:electron
```

运行 Electron E2E 前必须取得用户明确许可，不能通过其他命令绕过；未获许可时不执行，按项目约定默认无问题。

## 打包与安装目录验证

```sh
pnpm agent:build
pnpm agent:smoke
pnpm build:unpack
```

`build:unpack`、`build:mac`、`build:win` 和 `build:linux` 均先构建原生运行包。PyInstaller 必须在目标 OS/CPU 原生构建；不能通过指定 electron-builder 架构来交叉编译 Python。原始目录在 `agent-engine/dist/<platform>-<arch>/lingo-agent/`，归档位于 `agent-engine/dist/lingo-agent-<platform>-<arch>.tar.gz`，保存执行权限及符号链接。取得目标平台的归档后先解压到相应架构目录，再用于桌面打包。生成物全部忽略，不提交仓库。

electron-builder 复制该目录至 `resources/agent-engine/`，置于 ASAR 外。manifest 中应用版本、协议、OS 与 CPU 任一不匹配都会安全拒绝启动。应用启动不安装依赖，也不读取 Renderer 指定的命令、路径或环境。

`agent:smoke` 从独立临时工作目录、空 PATH、无虚拟环境变量启动冻结可执行文件，验证握手→受控测试工具循环的操作与 text/result 终态→流式任务→中英文概念讲解与宿主失败→20 词双并发图→20 短语双并发图→中英文近义词各 20 项顺序多轮图→近义词取消与迟到结果→中英文探索短语与探索词汇三轮补足及取消迟到回执→双语句子练习提示与点评及取消迟到回执、宿主失败→概念讲解取消→迟到结果→崩溃→重启与概念讲解重试→带活动任务退出，并输出包体积、耗时与可测的资源数据。Windows 的资源指标为空；不代表占用为零。

`tests/e2e/python-agent.test.ts` 默认覆盖开发解释器和冻结运行包。构建 `electron-builder --dir` 后，显式设置 `LINGO_MATE_TEST_PACKAGED=1` 再运行该测试，还会启动安装布局中的应用，检查 `app.isPackaged` 路径。生产设置不提供运行时切换页面。

```sh
LINGO_MATE_TEST_PACKAGED=1 pnpm exec playwright test tests/e2e/python-agent.test.ts
```

macOS 本地包使用 PyInstaller 的 ad-hoc 签名。正式发行还需原有 Apple Developer ID、嵌套二进制签名与 notarization 验收；本仓库未配置发行证书，本次未改变 `notarize: false`。Windows 正式发行签名亦需发布环境验证。

## 协议演进与排错

当前协议为 v11。应用提交 `conversation-title`、`conversation`、`vocabulary`、`phrase`、`synonym`、`explore-phrase`、`explore-vocabulary`、`sentence-practice-hints`、`sentence-practice-review`、`vocabulary-practice-review` 或 `tts` 任务，`/concept` 在 Python 内部识别。`model.reply` 与标题专用 `model.title` 必须提供完整 `systemPrompt`，TS 模型适配器原样发送，不再选择 Agent Prompt。Prompt 上限为 4096 个 UTF-16 单元，两端校验实际 Prompt 加历史的总输入预算；旧运行包必须重建。其余显式技能及练习暂沿用 TS 实现，未来新增 Agent 策略和工作流统一在本模块实现。

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

尚未验收：其余 OS/CPU 的原生构建与实际运行、正式签名/公证及干净机器安装。空 PATH 烟测证明独立运行包不依赖系统 Python，不能代替所有平台的完整安装验收。因此计划保留“实施中”状态。

## 参考

- [LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api)
- [PyInstaller 目录式分发](https://pyinstaller.org/en/stable/operating-mode.html)
- [GitHub 原生 runner 架构](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

## Python 唯一运行时验收

2026-10-21 的 v2 变更已通过 macOS arm64 的开发解释器、冻结包和安装布局端到端验证，以及空 PATH 运行包烟测。完整结果与尚未执行的平台见 [Python 唯一运行时计划](../docs/plans/2026-10-21-python-only-agent-runtime.md)。此前性能数字保留为历史观测，不代表本次构建的性能承诺。

## 概念讲解独立图

`/concept` 的专用图位于 `workflows/conversation/concept.py`，采用 `START → explain → END`。入口仅在 `conversation` 任务的最新消息为 user 且符合既有命令边界时选择该图；空命令和 ECMAScript 空白规则保持原样，普通追问重新走普通对话图，不根据历史命令粘连任务。

图使用既有概念讲解 Prompt，一次 `model.reply` 请求直接流式回复。解释及比较使用界面语言，例句使用学习语言；保留语境澄清、拼写确认、不编造词源与不执行外部操作的规则。原始命令和历史上下文由宿主原样绑定，不增加路由模型请求或查询词库。

`workflows/common.py` 统一回复的权限、Prompt／历史输入、输出、模型调用和步数预算检查，以及运行初态和错误类型。字符预算按 UTF-16 单元计算，Prompt 上限仍为 4096。单节点图为结束检查保留必要的调度轮次，实际操作仍受步数预算约束。取消、超时及故障沿用原有服务和宿主边界，无自动重试或回退。

本次只拆分 Python 内部流程，继续使用 `conversation` 任务、协议 v4 和现有 IPC／运行接口。运行包需重新构建以包含专用图。实施与验收见 [概念讲解计划](../docs/plans/2026-10-22-concept-langgraph-agent.md)。

## 词汇 LangGraph 与协议 v3

`/vocabulary` 的 `prepare → analyze → finalize` 图位于 `workflows/vocabulary/graph.py`，分析 Prompt 仅由 Python 生成。准备节点经 `vocabulary.prepare` 获取宿主规范化、查重后的必要词项；两个 worker 逐词调用 `model.vocabulary`，只传绑定索引及完整系统指令，最多 20 次，不自动重试。词汇不转发正文或思考片段，只返回严格校验的 `vocabulary_result` 完成标记。

TS 保留每个运行的原始词项、配置快照、校验后的学习内容与系统字段。每词 30 秒、分析窗口 120 秒，窗口到期后的未启动项返回 TIMEOUT 且不请求供应商；已有有效项可形成部分成功报告。总硬截止 180 秒包含启动。词汇最多 20 次模型调用、2 次工具调用、32 步；对话默认预算不变。宿主按实际 Prompt、绑定词项 JSON 与工具定义核对输入预算，Python 使用逐词输入与工具预留做有界检查；输出预算仅计跨协议安全回执，不传输学习内容。

宿主在图终态核验完成索引完整且无重复后，进入 committing 阶段，最后检查取消并执行同步事务，词条和批次报告原子落盘。引擎故障、越权、非法索引、重复词项分析或过量并发会明确失败并取消同运行的其余请求，不触及词库；取消后不接收迟到结果。已提交报告但回复保存失败时，仅本地恢复回复。AI 导入逐词通过同一 Python 图取得 Prompt，保留原有导入工作流。

协议 v3 同步扩展能力握手、任务、宿主调用和结构化终态；v1/v2 运行包均不兼容。生成 schema 后不要单独格式化 JSON 生成物，否则会触发 `agent:protocol` 的逐字同步检查。词汇端到端验收及尚未验收的平台见 [词汇迁移计划](../docs/plans/2026-10-21-vocabulary-langgraph-agent.md)。

2026-10-21 的 v3 词汇迁移已完成 macOS arm64 的开发解释器、冻结包、真实管道、Electron 词汇及 AI 导入验收，空 PATH 烟测新增 20 词双并发图。最终测试结果及本次未执行的安装布局、其他平台验收见 [词汇迁移计划](../docs/plans/2026-10-21-vocabulary-langgraph-agent.md)。

## 短语 LangGraph 与协议 v4

`/phrase` 的图位于 `workflows/phrase/graph.py`，采用 `prepare → analyze → finalize`。`phrase.prepare` 返回规范化、查重后的必要短语；两个 worker 逐项调用 `model.phrase`，参数仅含绑定索引与 Python 生成的完整系统指令。已有项和重复项不请求模型，单项结果通过安全回执返回，图最终发送 `phrase_result` 完成索引。

短语和词汇使用独立任务权限，同一进程中的每个批次最多两个同领域模型调用，其他任务仍只允许一个在途宿主调用。每批最多 20 项、单项 30 秒、分析窗口 120 秒、含启动的硬截止 180 秒；模型／工具／步数预算为 20／2／32。Prompt 上限 4096 个 UTF-16 单元，宿主核对实际 Prompt、绑定短语 JSON 与工具定义的总输入。

TS 宿主账本保留原始输入、规范化身份、配置快照和校验后的内容。完整核验图完成索引后，才在同步短事务内写入短语和报告。取消、引擎故障或非法协议在提交前丢弃暂存内容；已提交报告的回复恢复不调用图或模型。Prompt 保留 `phrase-tools-v1` 语义，`explantation` 字段不变；不增加数据库迁移、自然语言识别、自动重试或回退。

协议 v4 同步扩展任务、握手、调用和终态，v1/v2/v3 运行包均不兼容，必须随应用重建。空 PATH 烟测覆盖 20 项短语图；完整验证结果见 [短语迁移计划](../docs/plans/2026-10-21-phrase-langgraph-agent.md)。

2026-10-21 的 v4 短语迁移已完成 macOS arm64 开发解释器、真实管道、冻结运行包与 Electron 全套验收。空 PATH 烟测覆盖词汇和短语各 20 项双并发图；最终测试结果、安装布局跳过项及其他平台边界见 [短语迁移计划](../docs/plans/2026-10-21-phrase-langgraph-agent.md)。

## 近义词 LangGraph 与协议 v5

`/synonym` 使用 `workflows/synonym/graph.py`，Python 持有 Prompt、逐词顺序、多轮工具调度、Gemini 单次多工具纠正、轮次上限及完成索引。宿主操作仅开放 `synonym.prepare`、`model.synonym`、`synonym.apply`、`synonym.finish`，最终发送 `synonym_result`。词项、完整模型消息、供应商思考／签名状态、工具参数、分组分页、业务身份与学习内容均留在 TS；跨管道仅传完整 Prompt、索引、轮次、决策类别、计量与安全状态。

TS 每轮只做一次模型传输，并保留同一批次的模型配置快照与客户端。宿主严格核验词项顺序、轮次、待执行决策、查询分页和分组授权；不能由 Python 提交任意工具参数。每词最多 60 秒、52 轮、50 页，每批最多 20 项，取得串行执行权后含启动的总硬截止 180 秒。模型／非模型宿主调用／步骤预算为 1040／1061／2200，单轮实际输入上限 65,536、累计安全回执上限 524,288 个 UTF-16 单元。Prompt 4096 和帧大小限制不变，其他任务预算不放宽。

保留既有逐词事务和跨会话批次串行处理；后一个词可查询前一个词刚创建的分组。取消显示已提交结果；引擎故障、协议错误或批次硬截止明确失败并保留未完成报告。仅用户显式重试继续剩余词，完整报告则本地恢复回复。无 TS Agent 直跑、回退、数据库迁移或失败请求自动重放。协议 v5 必须重建运行包；验收见[近义词迁移计划](../docs/plans/2026-10-22-synonym-langgraph-agent.md)。

## 探索短语 LangGraph 与协议 v6

`/explore-phrase` 使用 `workflows/explore_phrase/graph.py` 中的独立 `prepare → generate → 条件补足 → finalize` 图，最多串行生成三轮。Python 持有 `explore-phrase-tools-v1` Prompt，明确短语与例句使用英语、解释使用语言设置；TS 模型适配器只发送完整 `systemPrompt` 和宿主绑定的数据，沿用 `submit_explored_phrases` 与 `phrase_analysis` 记账。

生产任务仅开放 `explore-phrase.prepare`、`model.explore-phrase`，完成帧为 `explore_phrase_result`。Python 仅接收已接受数量、轮次与下一轮输入大小；JSON 历史、候选正文、排除列表、模型配置与外层身份留在 TS。宿主验证调用顺序、禁止并发及重复轮次，核验实际轮数与数量后才允许提交。

固定 10 项、近 7 批去重和 JSON schemaVersion 1 保持原样。工具结构无效消耗一次尝试，第三轮仍不足 10 项明确失败；网络、模型配置、工具能力和引擎故障立即失败。请求 60 秒，取得锁后准备与生成总计 180 秒（包含启动）；提交阶段不受生成计时器打断，等待实际存储结果。运行预算为模型／非模型调用／步骤 3／1／8，输入 65,536、安全回执 32,768 UTF-16 单元，Prompt 4,096。其他任务预算不变。

图完成前取消或故障丢弃暂存候选；已提交的回复恢复直接读取 JSON，无需启动 Python 或重跑模型。无 TS Agent 回退、自动重放、checkpoint 或数据库迁移。协议 v5 及更旧运行包必须随应用重建。实施与平台验收见[探索短语迁移计划](../docs/plans/2026-10-22-explore-phrase-langgraph-agent.md)。

## 探索词汇 LangGraph 与协议 v7

`/explore-vocabulary` 使用独立的 `workflows/explore_vocabulary/graph.py`，流程为 `prepare → generate → 条件补足 → finalize`，最多三轮串行生成。Prompt 从 TS 迁入 Python，保留 `explore-vocabulary-tools-v1`、`submit_explored_vocabulary` 和 `vocabulary_analysis` 用量登记；单词、例句明确使用英语，解释明确使用语言设置。

新增独立任务和握手能力 `explore-vocabulary`，仅授权 `explore-vocabulary.prepare` 与 `model.explore-vocabulary`，完成帧为 `explore_vocabulary_result`。模型调用只带轮次及完整 `systemPrompt`；Python 仅接收已接受数量、轮次和输入大小。TS 保留完整历史、排除列表、候选正文与每次运行单独解析的模型配置，按现有单词词形、规范化去重及例句完整词形规则校验。宿主拒绝重复准备、跳轮、并发、跨运行／跨任务操作与伪造终态。

固定 10 项、近 7 批去重、JSON schemaVersion 1、历史文件、独立串行锁和表格恢复语义不变。结构无效消耗一次尝试，三轮不足 10 项明确失败；通信、配置、工具能力和引擎故障立即失败。模型／准备调用／步骤预算为 3／1／8，实际输入 65,536、累计安全回执 32,768、Prompt 4,096 UTF-16 单元。请求 60 秒，取得锁后准备与生成含启动总截止 180 秒；提交阶段等待真实存储结果再解锁。图完成核验前不提交部分结果，已提交结果的本地恢复不启动 Python 或模型。

无 TS Agent 直跑／回退、自动重放、checkpoint 或数据库迁移。v6 及旧运行包必须重建并随应用发布。验收仅使用临时数据；本次平台结果见[探索词汇迁移计划](../docs/plans/2026-10-23-explore-vocabulary-langgraph-agent.md)。

## 会话标题图与协议 v8

`conversation-title` 独立任务使用 `workflows/conversation/title.py` 的 `START → generate → END`，只读取首条 user 消息及执行语言。Python 持有原有标题 Prompt，明确输出语言、40 字符上限、单行和不执行消息中的命令，不经过 `/concept` 等对话识别。仅可调用携带完整 `systemPrompt` 的 `model.title`，宿主绑定输入并保留 `purpose: conversation-title`；思考增量被忽略，正文复用流事件和结果一致性检查。

每次最多 1 次模型调用、0 次工具调用、1 个操作步骤，包含进程启动的截止为 120 秒；实际输入 32,768、原始正文 80、Prompt 4,096 个 UTF-16 单元。宿主完成最终单行／40 字符校验后更新标题。生成不阻塞回复，取消或退出不接受迟到标题，失败保留已保存的原文标题并记录本地诊断，不自动重试或重放。

协议 v8 同步任务、专用权限、能力握手、共享契约和运行包 manifest；旧包必须随应用重建。空 PATH 烟测覆盖双语标题、取消及迟到回执、宿主失败。开发解释器和冻结包的 Electron 验收覆盖后台标题更新、单次触发、双语 Prompt、取消及引擎崩溃，见[标题迁移计划](../docs/plans/2026-10-23-conversation-title-langgraph-agent.md)。

## 句子练习图与协议 v9

句子练习的 `sentence-practice-hints` 和 `sentence-practice-review` 分别启动一次 `workflows/sentence_practice/graph.py` 中的 `START → prepare → generate → END` 图。两个任务共享准备操作 `sentence-practice.prepare`，仅开放各自的 `model.sentence-practice-hints` 或 `model.sentence-practice-review`；图按任务选择原有 Prompt，明确短语／改写用学习语言、解释／反馈用界面语言。两种支持语言下的 Prompt 均与原 TS 文本逐字一致。

词条、参考释义、提示、答案、配置及校验后的模型正文留在宿主；准备回执只有实际输入大小，模型回执及 `sentence_practice_result` 只有 `{completed: true}`。模型参数只含完整 `systemPrompt`，TS 适配器不选择 Prompt。每次运行独立绑定输入，拒绝跨任务、跨运行、重复准备／调用、越额并发及提前完成；宿主核验图完成后才释放暂存结果。

每次最多 1 次模型调用、1 次准备调用及 2 个操作步骤，含启动总截止 120 秒，供应商请求 60 秒；实际模型输入／累计安全回执／Prompt 为 65,536／1,024／4,096 个 UTF-16 单元。固定抽取三词、3–6 条覆盖全部词项的提示、结构及词项 ID 校验、点评前置条件和内存会话生命周期保持原有行为。取消、超时、协议或引擎故障明确失败，丢弃迟到结果，无自动重试、TS Agent 直跑或回退。失败后的下一次用户请求可重新启动引擎。

协议 v9 同步任务、操作、能力握手、共享契约及运行包 manifest，v8 及旧包必须重建。抽词、会话及业务规则仍在 TS，不新增数据库迁移或练习历史。空 PATH 烟测覆盖双语提示与点评、取消／迟到回执及宿主失败，验证记录见[句子练习迁移计划](../docs/plans/2026-10-23-sentence-practice-langgraph-agent.md)。

## 词汇练习批改图与协议 v10

`vocabulary-practice-review` 进入 `workflows/vocabulary_practice/graph.py`，按 `prepare → model → apply / correct → model → finish` 执行有界循环；全部正确时直接结束，不要求调用标红工具。Python 持有原有中英文系统 Prompt、最多两次补标指令及最多八轮策略。TS 模型适配器每次只请求一次供应商，不再选择 Prompt 或驱动循环。补标指令显式指定 summary 与 reason 的输出语言。

权限仅限 `vocabulary-practice.prepare`、`model.vocabulary-practice-review`、`vocabulary-practice.apply`、`vocabulary-practice.correct`、`vocabulary-practice.finish`。模型调用绑定连续轮次及固定完整 `systemPrompt`；apply 只能执行宿主上一轮待处理的调用，correct 只能响应缺少标记的最终反馈。词条、外层会话／请求 ID、答案、参考释义、完整模型消息、reason、summary 和工具参数留在 TS，Python 只接收输入大小、轮次、结果分类及安全回执。`vocabulary_practice_result` 核验后宿主才向领域服务释放结果，随后沿用整批错题保存和 requestId 幂等语义。取消／故障不发布暂存标记，失败不重放，不回退到 TS。

模型／非模型宿主调用／步骤上限为 8／10／18；含启动总截止 120 秒、供应商请求 60 秒。每轮实际输入包含完整消息和工具定义，上限 65,536 UTF-16 单元；累计回执／单个 Prompt 上限均为 4,096，单轮原始模型消息上限 65,536。两端校验预算；宿主另行拒绝错序、重复、越权、并发调用和伪造完成。IPC 将开始练习的窗口绑定为 owner，跨窗口无法批改或取消，owner 销毁时中止练习。

协议 v10 同步生成 schema、共享契约、能力握手及运行包 manifest，v9 及旧运行包须随应用重建。空 PATH 烟测覆盖双语全对／标红／补标、取消／迟到回执与宿主故障。不改变数据库结构，不访问真实用户数据库。

## 文本转语音图与协议 v11

`/tts` 是模型调用预算为 0 的确定性任务。`workflows/tts.py` 的单节点图仅调用一次 `tts.synthesize`，宿主绑定原文并复用已有 HeadTTS 服务；Python 不接收原文、音频、时间轴或消息身份，仅接收 `{completed: true}`。宿主核验 `tts_result` 后提交 SQLite 音频与恢复报告；故障与取消不重放请求。

预算为 1 次非模型宿主调用、1 步，含启动总截止 180 秒，安全回执上限 1,024 UTF-16 单元。原文和音频沿用现有 4,000 UTF-16 单元、120 秒、8 MiB 等限制。会话标题使用本地原文摘要；未配置 LLM 时仍能使用。协议 v11 扩展任务、能力握手与专用终态，旧运行包必须随应用重建。空 PATH 运行包烟测覆盖确定性 TTS 图。

## 工作流目录重构验收

2026-10-27 已完成独立任务分发器及按功能聚合图与 Prompt 的目录迁移。协议保持 v11；40 组迁移前固定 Prompt 输出逐字一致，全部 Python 行为、静态检查及 TypeScript 真实管道测试通过，macOS arm64 原生冻结包的空 PATH 烟测覆盖全部任务（含受控测试工具循环）。具体命令、结果及平台边界见[工作流目录重构计划](../docs/plans/2026-10-27-python-workflow-organization.md#实施记录2026-10-27)。E2E 未执行，按约定默认无问题；其他 OS/CPU 和安装布局留待对应发布环境验收。
