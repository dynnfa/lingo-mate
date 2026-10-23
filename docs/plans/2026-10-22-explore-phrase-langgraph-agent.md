# `/explore-phrase` 完整迁移至 Python / LangGraph

- 日期：2026-10-22
- 状态：已实施
- 分支：`feature/explore-phrase-langgraph-agent`（基于干净的 `main`，`3d9e909`）

## 实现

- Python 持有 `explore-phrase-tools-v1` Prompt 和 `prepare → generate → 条件补足 → finalize` 图，最多串行生成三轮。保留无参数命令、10 项、近 7 批去重、双语解释、原有模型工具契约与用量记账。
- TS 运行级账本保留历史快照、候选正文、排除列表及单次解析的模型配置，执行原有规范化、去重与例句校验。Python 只接收计数、轮次和输入大小，完整 Prompt 由 Python 提供。
- 协议升级 v6，增加探索短语任务与能力、两项独立宿主操作和完成帧；同步生成 schema、共享契约、握手及 manifest。拒绝越权、重复／跳轮、并发和伪造终态。
- 预算为模型／准备调用／步骤 3／1／8，单次请求 60 秒，取得串行锁后准备与生成总计 180 秒（包括启动）；实际输入 65,536、安全回执 32,768、Prompt 4,096 UTF-16 单元。其他任务预算不变。
- 凑齐 10 项并核验图终态后，才原子替换 JSON 历史。取消或故障丢弃暂存候选；提交阶段等待实际存储结果再解锁。保留外部修改检测、受保护批次、提交不确定和回复恢复行为。已提交恢复无需 Python 或模型请求。
- 删除 TS Agent 补足循环与 Prompt；Renderer、Preload、历史文件 schema 不变。本次不迁移 `/explore-vocabulary`，不增加数据库迁移、checkpoint、自动重放或回退路径。

## 验证

逐行为 TDD 已确认独立图缺失、协议未授权及运行时未接入的预期失败，再实现对应行为。验证覆盖图补足与耗尽、双语 Prompt、预算与取消、宿主候选过滤和模型配置快照、真实管道越权与提前终态、进程崩溃及显式新请求；复用 JSON 原子写入、7 批淘汰、跨会话串行、取消时序和历史恢复测试。冻结包烟测覆盖双语三轮补足与取消迟到回执；Electron 覆盖生成、补足、取消、显式重试和重启恢复。

所有数据验证使用内存 SQLite 或临时用户目录，未访问真实用户数据库。平台为本机 macOS arm64 / CPython 3.13.3 / LangGraph 1.2.12；其他 OS/CPU 的原生构建与安装布局验收仍需在目标平台执行。

本机最终检查：

- `pnpm agent:sync`：锁定环境同步完成。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm agent:protocol`：通过；生成 schema 同步，冻结运行包 manifest 为协议 v6。
- `pnpm test`：150 个文件、1696 个测试通过，包含真实 Python 管道、内存／临时 SQLite 与本地回环假模型。
- `pnpm agent:test`：177 个测试通过；`pnpm agent:check` 的 Ruff、格式及严格 mypy 全部通过。
- `pnpm agent:build`、`pnpm agent:smoke`：macOS arm64 冻结包构建及空 PATH 烟测通过，包含双语三轮补足与取消迟到回执。
- `pnpm test:electron`：60 条通过、1 条按既有条件跳过。跳过项为需要显式原生 electron-builder 安装布局的 packaged 场景（`LINGO_MATE_TEST_PACKAGED=1`）；开发解释器、冻结运行包和探索短语 4 条用例均通过。

Electron 探索用例先等待明确业务终态，再检查表格；等待窗口覆盖既有 30 秒握手时限，避免将旧表格断言的 5 秒默认等待误作运行时上限。
