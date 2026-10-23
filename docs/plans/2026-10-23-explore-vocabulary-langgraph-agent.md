# `/explore-vocabulary` 完整迁移至 Python / LangGraph

- 日期：2026-10-23
- 状态：已实施
- 分支：`feature/explore-vocabulary-langgraph-agent`（基于 `8bdb835`）

## 实现

- Python 持有独立词汇探索图及 `explore-vocabulary-tools-v1` Prompt，按 `prepare → generate → 条件补足 → finalize` 最多串行三轮。保留无参数命令、10 个英文单词、双语解释及现有工具契约。
- TS 运行级账本保留历史、排除列表、候选正文与单次解析的模型配置，执行原有单词词形、规范化去重及例句完整词形校验。Python 仅获得轮次、计数和输入大小。
- 协议 v7 新增独立任务、能力、两项宿主操作和完成帧；同步生成 schema、共享契约、握手及运行包 manifest。宿主拒绝越权、错序、并发和伪造终态。
- 模型／准备调用／步骤预算为 3／1／8，单次请求 60 秒，取得锁后准备与生成总截止 180 秒（含启动）；实际输入 65,536、安全回执 32,768、Prompt 4,096 UTF-16 单元。其他任务预算不变。
- 核验图终态且凑齐 10 项后才原子替换 JSON 历史，保留最近 7 批、跨会话串行、幂等、受保护批次、外部修改检测、提交不确定及回复恢复。提交期间等待实际存储结果再解锁。
- 删除 TS Agent 补足循环及 Prompt；未改变 Renderer、Preload、历史 schema 或数据库。无回退、自动重放或 checkpoint。

## 验证

逐行为 TDD 已确认词汇探索图未接入、协议未授权和生成请求缺少 Python Prompt 的预期失败，再实现并通过对应测试。其余既有业务行为测试接入真实 Python 管道复用。覆盖双语补足、三轮耗尽、非法词形及例句、配置快照、输入预算、启动截止、取消与提交时序；真实管道覆盖跨运行／调用／任务越权、错序、伪造终态、正文隔离和崩溃后显式新请求。

所有验证使用内存／临时 SQLite、临时用户目录与本地回环假模型，不访问真实用户数据库。本机平台为 macOS arm64 / CPython 3.13.3 / LangGraph 1.2.12；其他 OS/CPU 原生构建、正式签名及安装布局须在目标环境另行验收。

本机检查结果：

- `pnpm agent:sync`：锁定环境同步完成。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm agent:protocol`：通过，生成 schema 同步。
- `pnpm test`：152 个文件、1731 个测试通过，包含真实 Python 管道。
- `pnpm agent:test`：192 个测试通过；`pnpm agent:check` 的 Ruff、格式及严格 mypy 全部通过。
- `pnpm agent:build`、`pnpm agent:smoke`：macOS arm64 冻结包构建和空 PATH 烟测通过，`runtime.json` 为协议 v7。烟测包含双语三轮补足、取消及迟到回执。
- `pnpm test:electron`：63 条通过、1 条按既有条件跳过。跳过项为需要显式 electron-builder 安装布局和 `LINGO_MATE_TEST_PACKAGED=1` 的 packaged 场景；开发解释器、冻结运行包及词汇探索四个场景均通过。词汇探索与短语导入的九条针对性验证也已通过。

词汇探索端到端用例等待明确业务终态后检查表格，等待窗口覆盖既有 30 秒启动握手。全套验收中发现既有短语冻结包测试在助手占位消息出现后过早读取数据库；已改为等待“回复完成”后断言持久化，未改变产品行为。
