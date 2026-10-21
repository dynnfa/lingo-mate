# Lingo Mate Agent Engine

本模块只负责内存中的 LangGraph 编排。会话与消息持久化、语言学习规则、模型凭据、供应商请求和用量统计均由 TypeScript 宿主负责。生产只接入普通对话与 `/concept`；模型决策/只读工具循环通过测试扩展验证。无 checkpoint、业务数据库访问、云端 tracing 或模型 SDK 请求。

决策与限制见 [ADR](../docs/adr/2026-10-21-python-langgraph-agent-engine.md)。协议源位于 `src/core/agent/agent-protocol.ts`；生成的 `protocol/schema.json` 随包发布，不能手改。共享契约样例在 `tests/integration/fixtures/agent/protocol-cases.json`。

## 开发

从仓库根目录运行，需要 pnpm、Node 22.6+、uv 和锁定的 Python 3.13.3：

```sh
pnpm agent:sync
pnpm agent:protocol
pnpm agent:test
pnpm agent:check
LINGO_MATE_AGENT_RUNTIME=python pnpm dev
```

PowerShell 使用 `$env:LINGO_MATE_AGENT_RUNTIME='python'` 后运行 `pnpm dev`。默认不启用试点；启用后的启动/协议/执行故障不会回退。开发解释器只从本仓库 `.venv/bin/python`（Windows `.venv/Scripts/python.exe`）启动，不搜索 PATH。手动入口为 `.venv` 中的 `python -I -m lingo_agent`，只接受 JSONL 管道协议。

所有检查与测试均使用锁定环境。Python 测试在 `src/lingo_agent/__tests__/test_*.py`，pytest 发现规则由 `pyproject.toml` 配置。执行 TypeScript 全量测试前也要完成 `agent:sync`；新增进程集成测试确实启动 Python，不会在缺环境时悄悄跳过。测试仅使用可控替身/本地假模型服务。

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

`build:unpack`、`build:mac`、`build:win` 和 `build:linux` 均先构建原生运行包。PyInstaller 必须在目标 OS/CPU 原生构建；不能通过指定 electron-builder 架构来交叉编译 Python。原始目录在 `dist/<platform>-<arch>/lingo-agent/`，同级 tar.gz 保存执行权限及符号链接。下载 CI 产物后先解压到相应架构目录，再用于桌面打包。生成物全部忽略，不提交仓库。

electron-builder 复制该目录至 `resources/agent-engine/`，置于 ASAR 外。manifest 中应用版本、协议、OS 与 CPU 任一不匹配都会安全拒绝启动。应用启动不安装依赖，也不读取 Renderer 指定的命令、路径或环境。

`agent:smoke` 从独立临时工作目录、空 PATH、无虚拟环境变量启动冻结可执行文件，验证握手→流式任务→取消→迟到结果→崩溃→重启→带活动任务退出，并输出包体积、耗时与可测的资源数据。Windows 的资源指标为空；不代表占用为零。

`tests/e2e/python-agent.test.ts` 默认覆盖开发解释器和冻结运行包。构建 `electron-builder --dir` 后，显式设置 `LINGO_MATE_TEST_PACKAGED=1` 再运行该测试，还会启动安装布局中的应用，检查 `app.isPackaged` 路径。生产设置不提供运行时切换页面。

```sh
LINGO_MATE_TEST_PACKAGED=1 pnpm exec playwright test tests/e2e/python-agent.test.ts
```

CI 为 macOS arm64/x64、Linux arm64/x64、Windows arm64/x64 配置原生 Python 检查、真实管道集成、生产包烟测、桌面目录构建及 Electron 试点测试。CI 配置见 `.github/workflows/agent-engine.yml`；配置存在不等于对应平台通过。

macOS 本地包使用 PyInstaller 的 ad-hoc 签名。正式发行还需原有 Apple Developer ID、嵌套二进制签名与 notarization 验收；本仓库未配置发行证书，本次未改变 `notarize: false`。Windows 正式发行签名亦需发布环境验证。

## 协议演进与排错

- 修改 Zod 协议后运行 `node --experimental-strip-types scripts/agent-protocol-schema.mjs`，更新共享用例；破坏性修改提升协议版本并重建全部运行包。
- stdout 专用于协议，Python 不输出用户错误文案或 traceback。stderr 只由 Main 有界接收并进入已有本地错误日志。
- `AGENT_UNAVAILABLE`：检查 `.venv` 或安装资源完整性、manifest、执行权限及启动次数上限。只对后续新请求重启，不重放失败任务。
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
