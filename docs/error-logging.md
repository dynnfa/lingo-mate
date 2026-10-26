# 统一按天错误日志

- 日期：2026-09-18
- 文档核对：2026-10-21（补充 Python Agent 诊断与退出顺序）
- 状态：已实施

## 目标与边界

各模块（Main、Core、Preload、Renderer）运行中的错误统一追加到按本地日期命名的公共 JSONL 文件，保留排查所需的原始原因，同时对密钥等敏感信息脱敏。日志仅由 Main 写入本地磁盘，不回传 Renderer，也不输出到控制台（日志服务自身的固定诊断码除外）。

## 日志位置与格式

```text
<userData>/logs/
├── 2026-09-18.log
└── 2026-09-20.log        # 没有错误的日期没有文件
```

- Main 在启动最早阶段创建 `logs` 目录（0700）并注册进程级错误监听；文件 0600，同日重启继续追加。
- 每行一个 JSON 对象：`timestamp`（本地时区带偏移，与文件日期同口径）、`level`（`error`/`warn`）、`source`（`main`/`core`/`preload`/`renderer`）、`module`、`operation`、`code`、`message`、`error`（name/stack/cause 链/聚合错误）、`context`、`requestId`（有则携带）。
- 跨午夜按事件时间自动切到新文件；写入由单一串行队列完成，并发记录不产生交错行。
- 截断有明确标记：超长字符串追加 `[Truncated N chars]`；单条超过 64 KiB 时先丢弃 `context` 并置 `truncated: true`。本期不按大小拆分、不自动清理历史。

## 错误采集入口

| 来源               | 接入位置                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 进程级             | `installProcessErrorHandlers`：uncaughtException 尽力同步写入后按非零码终止；unhandledRejection 入队记录                                                                                                                   |
| Main 启动/生命周期 | 数据库、偏好初始化、语言解析回退、窗口 loadURL、render-process-gone、child-process-gone                                                                                                                                    |
| Python Agent       | `src/main/agent/python-agent-process.ts` 通过 `onDiagnostic` 交给 Main 公共日志，记录启动、握手、协议、断管与异常退出等失败；`source: main`、`module: agent`、`operation: process`。退出清理异常使用 `operation: shutdown` |
| IPC 公共守卫       | `ipc-guard` 诊断回调：来源拒绝（warn）、输入校验失败（warn，仅 issue path+code）、handler 异常（error，映射前原始原因）、错误映射异常、结果校验失败                                                                        |
| Core               | `src/core/error-diagnostics.ts` 诊断接口由 Main 注入：llm-usage 记账失败、synonym 单词失败（脱敏 cause 链）、AI 导入失败（含模型原始响应）、会话后台回复/标题/技能与重试失败（转换前原始异常及 requestId）                 |
| 词汇导入           | 提交失败回调从 electron-log 改为公共日志                                                                                                                                                                                   |
| Preload            | 会话事件/导入进度 schema 解析失败，经 `window.api.reportError` 上报                                                                                                                                                        |
| Renderer           | 全局 `error`/`unhandledrejection` 与顶层 React ErrorBoundary（`components/ErrorBoundary`）                                                                                                                                 |

主动取消不记录；已在源头记录的错误不因逐层转换重复写入。

Python 的 stdout 仅承载私有 JSONL 协议。Main 接收 stderr 时仅保留最后 8192 个 UTF-16 单元，在进程失败诊断中作为原因交给公共日志序列化层脱敏，不直接转发到 Renderer 或控制台，也不新增 Python 侧业务日志文件。日志记录异常不能阻止进程和在途任务清理。协议、权限及运行包边界见 [Agent Engine README](../agent-engine/README.md)。

## Renderer 上报通道

- 协议见 `src/shared/error-report.ts`：`window.api.reportError`，channel `error-log:report`。
- 复用 IPC 守卫的可信来源校验；载荷为受限 schema（不含时间、路径、进程身份），单条 ≤ 16 KiB。
- Main 生成可信时间戳；在守卫中按 sender 限流，所有尝试（含非法载荷和来源拒绝）共享预算（默认 30 条 / 10s，可信来源超出返回 `RATE_LIMITED` 并限频记录一条 warn）。
- 上报失败静默放弃，不重试、不再触发上报（防循环）。Renderer 没有任何读取日志的接口。

## 脱敏

统一由 `src/main/error-logger.ts` 的序列化层完成：

- 敏感字段名（headers/authorization/api key/token/cookie/password 等，全词匹配）→ `[REDACTED]`。
- 已登记密钥（`registerSecret`，统一模型客户端工厂在构造前登记请求快照，覆盖对话、学习与连接测试；只增不减以覆盖在途请求的旧密钥）替换所有文本中出现的位置，包括元数据、错误 name 和对象键名。
- 自由文本中的 `Bearer <token>` 与 URL 内嵌凭据 `//user:pass@` 一律脱敏。

## 日志服务自身失败

写入失败仅向控制台输出固定诊断码（如 `[error-logger] WRITE_FAILED`，60 秒限频），不回退打印原始日志、不影响业务结果、不递归记录。

正常退出先在 `before-quit` 停止会话、导入和练习服务，清理 Python 运行时并取消宿主调用，再有界等待会话结束，随后关闭数据库。清理异常写入公共日志后继续退出；最后在 `will-quit` 有界等待日志刷新（默认 1.5s），由 `app.exit(0)` 收尾。不能先关闭数据库或日志，再清理仍可能访问它们的 Agent 任务。

## 排查方式

1. 在 `<userData>/logs/YYYY-MM-DD.log` 中按 `module`/`operation`/`code`/时间过滤。
2. `source: renderer|preload` 条目来自页面；`module: ipc-guard` 条目的 `context.channel` 指出问题入口。
3. 关联一次操作：词汇导入条目带批次上下文；会话后台任务按 requestId 关联。
4. 出现 `[REDACTED]` 表示原值被脱敏；`truncated: true` 表示该条被收缩，可对照上游缩短采集面。
5. Python Agent 问题先筛选 `source: main`、`module: agent`，区分 `operation: process` 与 `shutdown`，再结合 `AGENT_UNAVAILABLE`、`AGENT_PROTOCOL_ERROR` 等诊断及本地 stderr 原因排查；不要求 Renderer 回传内部图状态或工具载荷。
