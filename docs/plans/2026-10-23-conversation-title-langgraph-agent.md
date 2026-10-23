# 会话标题生成迁移至 Python / LangGraph

- 日期：2026-10-23
- 状态：已实施
- 分支：`feature/conversation-title-langgraph-agent`（基于最新 main `729ee23`）

## 实现

- Python 持有原标题 Prompt 和 `START → generate → END` 独立图。`conversation-title` 只携带首条 user 消息及执行语言，不经过对话命令识别。
- 协议 v8 新增任务及专用 `model.title` 权限，同步生成 schema、共享契约、握手和运行包 manifest。调用参数仅有完整 `systemPrompt`；凭据、供应商请求、配置快照、用量和保存仍由 TS 宿主持有。
- 模型／工具／操作步骤预算为 1／0／1，包含启动的截止 120 秒；实际输入／原始正文／Prompt 上限为 32,768／80／4,096 个 UTF-16 单元。宿主忽略思考并复用文本终态一致性核验。
- 会话入口通过 `AgentRuntime.stream` 发起后台标题任务，删除 TS 标题 Prompt 和 `ConversationModule` 的直接模型依赖。保留首条消息触发、当次输出语言、最多 40 字符的单行校验、持久化和 `titleUpdated`。失败保留原文标题，不影响回复终态，无自动重试或 TS 回退。
- Renderer、Preload、IPC、数据库 schema 不变；更新 AGENTS、ADR、架构说明及引擎 README。

## 验证

逐行为 TDD 已确认 Python 标题路由未接入、宿主尚未授权标题任务，以及真实管道中标题仍走 TS 的预期失败，再实现并通过相应测试。覆盖双语 Prompt、命令作为素材、一次调用、权限隔离、UTF-16 输入／输出、预算拒绝、取消及失败不重试；复用既有标题校验、后台并发、迟到结果和持久化行为测试。

所有验证仅使用内存／临时 SQLite、临时用户目录和回环假模型，不打开真实用户数据库。本机为 macOS arm64 / CPython 3.13.3；其他 OS/CPU 原生构建、安装布局、正式签名及公证尚未验收。

本机最终检查结果：

- `pnpm agent:sync`：锁定环境同步完成。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm agent:protocol`：通过，生成 schema 同步。
- `pnpm test`：152 个文件、1,749 项测试全部通过，包含真实 Python 管道。另验证最长技能参数加命令前缀不会被标题快照截断或误拒绝。
- `pnpm agent:test`：208 项全部通过；`pnpm agent:check` 的 Ruff、格式及严格 mypy 全部通过。
- `pnpm agent:build`、`pnpm agent:smoke`：macOS arm64 冻结包构建、协议 v8 manifest 及空 PATH 烟测通过，覆盖双语标题、取消与迟到回执、宿主失败，以及全部既有图回归。
- `pnpm test:electron`：71 条通过、1 条按既有条件跳过。新增 8 条标题场景全部通过，覆盖开发解释器及冻结包的中英文后台更新、单次触发、取消及引擎崩溃。跳过项为需显式安装布局构建与 `LINGO_MATE_TEST_PACKAGED=1` 的 packaged 场景。

首次全量测试受沙箱的回环监听限制，使用沙箱外临时假模型服务器重跑后全部通过。首次 Electron 验收发现新增断言选中了包含角色名称的整张消息卡片，改为断言正文容器后全量通过，未调整产品行为。真实管道额外覆盖空白、多行、超长标题、供应商失败不重试，以及关闭时取消和丢弃迟到标题。
