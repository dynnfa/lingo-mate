# 句子练习迁移至 Python / LangGraph

- 日期：2026-10-23
- 状态：已实施
- 分支：`feature/sentence-practice-agent-engine`（基于 main `38d8670`）

## 实现

- Python 持有原有提示生成和答案点评 Prompt，通过 `sentence-practice-hints` 与 `sentence-practice-review` 两个显式任务进入 `START → prepare → generate → END` 图。两个支持语言下的实际 Prompt 与迁移前逐字一致。
- 协议 v9 新增任务、对应模型操作、准备回执及 `sentence_practice_result` 终态，同步生成 schema、能力握手、共享契约与运行包 manifest；旧包必须重建。
- 词条、参考释义、提示、答案、配置及完整模型结果留在 TS。Python 只接收实际输入大小及完成回执。模型参数仅有完整 `systemPrompt`；宿主拒绝重复／越权调用并核验图终态后才释放结果。
- 模型／准备调用／操作步骤预算为 1／1／2，含启动总截止 120 秒、供应商请求 60 秒；实际输入／累计安全回执／Prompt 上限为 65,536／1,024／4,096 个 UTF-16 单元。
- 保留三词抽样、会话及请求归属、3–6 条提示与词项覆盖、点评结构和词项 ID 校验、会话取消及关闭。无 TS Agent 直跑、回退、自动重试、失败重放或数据库变更。引擎错误仅把稳定代码传到 Renderer，复用现有中英文错误资源。
- 删除原 TS Prompt，在 Main 装配 Python 运行适配器；更新 AGENTS、ADR、架构说明和引擎 README。

## 验证

先确认 Python 未接入句子练习任务时按预期失败，再实现独立图；真实管道测试先确认缺少宿主适配器，再补齐接线。后续复用原有结果校验、会话、IPC 和组件行为测试。

新增覆盖：双语实际 Prompt、一次调用、内容及外层身份不跨管道、输入与回执预算、UTF-16 边界、权限隔离、重复准备／调用、越额并发、伪造完成、取消／引擎崩溃与迟到结果，以及显式新请求恢复。所有验证仅使用内存／临时数据库、私有管道和本地假模型，不打开真实用户数据库。

本机为 macOS arm64 / CPython 3.13.3。最终结果：

- `pnpm agent:sync`：锁定环境同步完成。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm agent:protocol`：通过。
- `pnpm test`：153 个文件、1,792 项测试全部通过，包含真实 Python 管道与新增引擎错误后的界面重试场景。
- `pnpm agent:test`：247 项全部通过。`pnpm agent:check`：Ruff、格式和严格 mypy 全部通过。
- `pnpm agent:build`、`pnpm agent:smoke`：macOS arm64 原生冻结包、协议 v9 manifest 与空 PATH 烟测通过。覆盖双语提示／点评、取消与迟到回执、宿主失败及已有全部图的回归。
- 额外逐字核对迁移前 TS Prompt 与 Python 实际 Prompt：中英文均一致。

首次全量测试受沙箱回环监听限制，允许临时假模型服务后重跑通过。最后一次全量回归包含全部最终代码与新增组件用例。未修改模型配置、真实用户数据库或持久化练习数据。

E2E 未执行，按约定默认无问题。其他 OS/CPU 原生构建、安装布局、正式签名与公证未在本次验收范围内。
