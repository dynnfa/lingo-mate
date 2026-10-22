# Python LangGraph 承担桌面 Agent 编排

- 日期：2026-10-21
- 状态：已接受
- 对应计划：`docs/plans/2026-10-20-python-langgraph-agent-engine.md`

## 决策

新增独立 `agent-engine/` 包，使用 CPython 3.13（开发与 CI 固定 3.13.3）、LangGraph 1.2.12、uv 锁文件和 PyInstaller 目录式分发。Electron Main 用固定路径、`shell: false` 和环境白名单启动共享 Python 子进程，通过私有 UTF-8 JSONL 管道通信。生产运行不依赖系统 Python、uv 或 PATH。

这次重新审视历史架构清单中“不引入通用 Agent 框架”的范围：Agent 策略、Prompt 与编排统一由 Python 持有，现有会话生命周期、领域执行、模型适配、用量账本、存储与事务继续由 TypeScript 持有。历史清单原路径为 `docs/architecture-todo.md`，当前仓库已不包含该文件，此处仅保留决策背景，不作为现行规范入口。当前约定见 [AGENTS.md](../../AGENTS.md)，运行边界以本 ADR 为准。

`ConversationModule` 必须注入 `AgentRuntime`，普通对话、`/concept`、`/vocabulary`、`/phrase`、`/synonym` 及 `/explore-phrase` 始终经过 Python，不保留 TypeScript 直跑分支或运行时选择参数。Python 根据最新消息识别 `/concept`，组装明确指定解释语言和学习语言的系统指令。标题、其余显式学习技能及练习暂沿用原流程，后续迁移；未来新增 Agent 策略和工作流统一在 Python 实现。故障返回明确错误，不能静默回退或重放失败请求。子进程仍在首个请求时启动。

Python 只得到不含会话/消息 ID、密钥和连接信息的运行快照。运行 ID、独立 call ID、事件序号和进程实例身份在 Main 中关联。模型配置在第一次宿主调用时解析一次，语言在会话执行开始时解析；同一运行内保持稳定。实际 Prompt 由 Python 组装，以 `model.reply` 的必填 `systemPrompt` 传给宿主；供应商请求、取消和记账继续通过原模型适配器执行。宿主不识别 Agent 命令、不选择 Agent Prompt，只使用绑定运行的历史与模型配置执行请求。

生产对话宿主仅开放 `model.reply`；词汇任务开放 `vocabulary.prepare` 与 `model.vocabulary`；短语任务开放 `phrase.prepare` 与 `model.phrase`，两个任务的权限相互隔离。词汇与短语由各自 Python 图准备、双并发分析及生成完成标记，宿主按绑定索引暂存校验结果，核对完成标记后才统一事务提交；Python 不持有写库能力。`model.decide` 和 `learning.lookup` 是受控测试扩展：用于验证模型→工具→模型循环，应用装配不注册这些处理器。工具查询必须来自上一步模型决策，工具结果由宿主保留并核对；不能分派任意函数、SQL、路径或外层会话方法。

## 协议与限制

当前协议版本为 6，严格拒绝额外字段。TypeScript Zod 是协议源，生成 Python 使用的 Draft 2020-12 JSON Schema；两端测试共用合法/非法样例，CI 检查生成物是否过期。版本变更必须同时更新握手、契约和运行包 manifest。

| 限制                     | 首版值                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| 共享进程最大在途运行     | 8（包括等待就绪）；满载立即失败，等待队列为 0                                                    |
| 单帧                     | 256 KiB，按字节而非字符计量                                                                      |
| 每端发送队列             | 1 MiB                                                                                            |
| 接收队列                 | Python 128 帧；Main 每运行 1024 个展示片段                                                       |
| 就绪握手                 | 30 秒；取消不需要等到握手结束                                                                    |
| 总运行截止时间           | 对话 120 秒；词汇与短语 180 秒（包含启动），分析窗口 120 秒；协议硬上限 180 秒                   |
| 默认模型 / 工具 / 图步数 | 对话 3 / 2 / 16；词汇与短语 20 / 2 / 32，分别计数                                                |
| 默认输入 / 输出          | 32768 / 32768 个 UTF-16 单元，输出包含思考片段                                                   |
| Prompt 与工具定义预留    | 4096 个 UTF-16 单元；Prompt 硬上限同为 4096；两端复核实际总输入；历史最多 100 条，只裁剪发送副本 |
| 取消确认 / 退出清理      | 各 1 秒；失去响应终止整个进程并失败其余在途任务                                                  |
| 进程启动次数             | 每次应用生命周期最多 3 次，不重放失败任务                                                        |

错误映射为 `AGENT_UNAVAILABLE`、`AGENT_PROTOCOL_ERROR`、`AGENT_LIMIT` 和 `AGENT_HOST_ERROR`，有中英文展示文案。原始宿主异常留在可信层，因此原有“模型未配置”和“凭据无法解密”等语义不丢失。stderr 有界进入 Main 本地诊断，不进入控制台或 Renderer。

## 成本与边界

引入第二套语言工具链、跨平台原生运行包和独立升级兼容检查。普通对话不增加模型路由请求。内存图没有 checkpoint、跨运行 Store、自动恢复或新增数据库迁移；现有用户记录格式不变，真实用户数据未用于验证。

Python 标准输入使用独立守护线程的非缓冲 OS 读取，避免父管道仍打开时解释器退出争用缓冲锁。读循环、宿主结果、取消控制与输出写入相互独立；背压时发送者有界等待，断管会释放所有发送者。

分发产物按 `platform-arch` 构建，manifest 校验应用版本、协议、OS 和架构。electron-builder 把运行包放在 ASAR 外；CI 用 tar 保存执行权限与符号链接。当前验证及未验证平台见 `agent-engine/README.md`，跨平台 CI 尚不能视为已通过验收。

## 后续决策记录

2026-10-21：从可选 Python 试点调整为唯一 Agent 运行时，并将普通对话和 `/concept` 的任务识别与 Prompt 从 TS 迁至 Python。协议升级至 v2，旧 v1 运行包不兼容，必须与应用一起重建和发布。历史试点实施记录保留在原计划中；本次实施与验证见 [Python 唯一运行时计划](../plans/2026-10-21-python-only-agent-runtime.md)。

2026-10-21：`/vocabulary` 完整迁至 Python LangGraph，协议升级至 v3。词汇图并发上限为 2，其他运行继续只允许一个在途宿主调用。TS 持有原始词项、去重、模型配置快照、分析内容与事务，Python 只取得必要词项和安全回执。AI 导入复用同一 Python Prompt 桥接，保留现有逐行分析和导入事务。取消或引擎故障在图完成前丢弃暂存内容；已提交报告沿用本地恢复路径，不重新调用模型。见 [词汇迁移计划](../plans/2026-10-21-vocabulary-langgraph-agent.md)。v2 运行包必须与应用一起重建。

2026-10-21：`/phrase` 完整迁至 Python LangGraph，协议升级至 v4。短语图沿用 `prepare → analyze → finalize`，每批最多 20 项、并发 2。TS 持有规范化、去重、内容校验、配置快照与原子事务，Python 只接收必要短语和安全回执。保留显式命令、`phrase-tools-v1`、`explantation` 字段与既有报告恢复语义；不增加自然语言识别、数据库迁移或 TS 回退路径。v3 及更旧运行包必须与应用一起重建。实施和验证见 [短语迁移计划](../plans/2026-10-21-phrase-langgraph-agent.md)。

2026-10-22：`/synonym` 完整迁至 Python LangGraph，协议升级 v5。近义词图按输入顺序执行 `prepare → select → decide ↔ apply → finish`，宿主仅按已绑定的模型决策执行四个原有工具；生产权限独立为 `synonym.prepare`、`model.synonym`、`synonym.apply` 和 `synonym.finish`。完整模型消息、思考及供应商签名状态、工具参数／结果与数据库身份留在 TS；Python 不接收业务内容或外层身份。TS 保留逐词事务和跨会话批次串行锁，已提交词不会因取消、故障或超时回滚；不引入 Python checkpoint 或自动重放。

近义词独立预算：20 项、每词 60 秒／52 轮／50 页，总硬截止 180 秒（取得串行执行权后，包含启动）；最多 1040 次模型请求、1061 次非模型宿主调用、2200 个步骤，单轮实际输入 65,536、累计安全回执 524,288 UTF-16 单元。Prompt 仍限 4096，帧仍限 262,144 字节；其他任务原有预算不放宽。终态核验仅确认流程完整，不作为逐词写库的前提。异常报告保持 `finalized: false`，显式重试保留已保存、已有和无法识别状态；完整报告的回复恢复不调用模型。v4 及旧运行包须与应用一同重建。实施与验收见[近义词迁移计划](../plans/2026-10-22-synonym-langgraph-agent.md)。

2026-10-22：`/explore-phrase` 完整迁至独立 Python 图，协议升级 v6。图按 `prepare → generate → 条件补足 → finalize` 最多串行生成三轮，保留 `explore-phrase-tools-v1` 与原有模型工具契约。生产权限独立为 `explore-phrase.prepare` 和 `model.explore-phrase`，终态为 `explore_phrase_result`。TS 账本持有排除列表和候选正文，Python 仅取得轮次、计数和输入大小。两端核验预算，宿主拒绝错序、并发、越权和伪造完成；凑齐 10 项并核验终态后才原子提交 JSON，保留最近 7 批历史及回复恢复语义。

探索短语预算为 3 次模型调用／1 次准备调用／8 个步骤，单次请求 60 秒，取得串行锁后准备与生成总截止 180 秒（包含启动）；实际输入 65,536、累计安全回执 32,768 UTF-16 单元，Prompt 与帧上限保持原值，其他任务预算不变。提交开始后等待真实存储结果，取消或故障不提交部分候选；已提交结果本地恢复不启动 Python。无 TS Agent 回退、自动重放或持久化结构迁移。v5 及旧运行包必须随应用重建。实施与验收见[探索短语迁移计划](../plans/2026-10-22-explore-phrase-langgraph-agent.md)。
