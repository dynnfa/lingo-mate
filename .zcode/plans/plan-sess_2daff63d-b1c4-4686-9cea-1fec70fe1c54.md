# 渠道启动/停止控制 + 开机自启动标记

## Context

Telegram 渠道当前没有任何启动入口:连接创建后永远处于 `stopped`,应用重启也不会连接,用户在 Telegram 发消息得不到任何响应。本方案为每个渠道卡片添加「启动」按钮,启动后显示「已启动」状态并提供「停止」按钮(用户已确认),将启动意愿持久化为连接记录上的 `autoStart` 标记,应用启动完成后自动恢复被标记渠道的通信。

## 最终行为规格

- **快照投影**:每个连接新增 `started: boolean`(由 Main 计算,`state` 不属于 `['stopped','error']` 即为 true,覆盖 starting/online/reconnecting/stopping)。
- **卡片 UI**:
  - 未启动(`started: false`)→ 显示「启动」按钮;点击调 `window.api.communication.start`,成功后刷新快照。
  - 已启动(`started: true`)→ 显示「已启动」状态标签 + 「停止」按钮,不再显示启动按钮;停止成功后回到启动按钮。
  - 启动/停止失败 → 卡片内联 `role="alert"` 错误(复用现有 `errors.<code>` 双语文案,如 `TELEGRAM_WEBHOOK_CONFLICT`);进行中用 `aria-disabled` 模式(与现有测试连接按钮一致)。
  - 成功后按钮卸载时,焦点移到卡片内新出现的按钮/状态标签,遵循设置页焦点管理约定。
- **持久化标记**:`service.start()` 的 claim 事务写 `autoStart = true`;`service.stop()` 事务写 `autoStart = false`。`recover()`/`shutdown()` 不触碰该字段 → 标记跨重启存活。轮换 Token 内部走 `stop`,会清除标记(轮换后需重新启动,与现有文档行为一致)。
- **开机自启**:`CommunicationHost.initialize()` 在 recover/cleanup 之后,扫描 `enabled && autoStart` 的连接,逐个 `void this.start(id)`(不阻塞 initialize,经 `coordinate` 串行;失败记 diagnostics `COMMUNICATION_AUTOSTART_FAILED`,连接落入 error/reconnecting 由既有重连机制处理)。

## 实现步骤(文件清单)

1. `src/core/communication/communication-repository.ts` — `Connection` 接口新增 `autoStart?: boolean`。**无需数据库迁移**:`communication_connections` 是纯 JSON blob 表,可选字段前向兼容(`createdAt` 先例)。
2. `src/core/communication/communication-service.ts` — `start()` 第一阶段 claim 事务(现 ~L87-98)加 `c.autoStart = true`;`stop()` 事务(现 ~L272-285)加 `c.autoStart = false`。
3. `src/main/communication/communication-host.ts` —
   - `initialize()`(~L73-95):recover/cleanup/prune 后扫描标记连接并异步启动;更新 L82 过时注释("Explicit start is required after restart")。
   - `snapshot()`(~L104-112):映射 `started` 字段。
4. `src/shared/communication.ts` — `communicationSnapshotSchema` 连接项新增 `started: z.boolean()`(必填,strictObject 会强制找出所有构造点)。
5. `src/renderer/src/settings/channels/ChannelsSettings.tsx` + `ChannelsSettings.css` — 启动/停止按钮、已启动标签(样式参照 `.channel-added-at`)、per-connection pending Set 与内联错误,成功后 `reload()`。
6. `src/shared/locales/{en,zh-CN}/communication.json` — 新增 `startChannel`(Start/启动)、`stopChannel`(Stop/停止)、`started`(Started/已启动);错误文案复用现有 `errors.*`。
7. `docs/communication-adapters.md` — 更新「启动、停止与账号绑定目前没有设置入口」「重启不自动连接平台」等过时表述(账号绑定仍无入口,如实保留)。

## 测试(TDD:先写失败测试再实现)

- `src/core/communication/__tests__/communication.test.ts`:start 持久化 `autoStart`;stop 清除;同一 DB 上重建 `CommunicationService`(模拟重启)标记存活。
- `src/main/communication/__tests__/telegram-management.test.ts`:`host.start` 后原始 JSON 行含 `autoStart`(仿 `createdAt` 的 `json_extract` 断言);同 DB 第二个 host `initialize()` 后被标记连接变 `online`、未标记保持 `stopped`;stop 清除标记。
- `src/main/communication/__tests__/communication-ipc.test.ts`:快照精确相等断言更新;start IPC 后 `started: true`,stop 后 `false`。
- `src/renderer/src/settings/channels/__tests__/ChannelsSettings.test.tsx`:卡片按钮列表断言更新;点击启动调用 `api.start({connectionId})` 后显示已启动标签且无启动按钮;停止按钮调用 `api.stop` 后恢复启动按钮;失败显示翻译后的错误码;中英双语标签断言(`it.each` 模式)。

## 验证

- `pnpm lint`、`pnpm typecheck`、`pnpm test`(含真实 Python 管道集成测试,环境未同步时先 `pnpm agent:sync`)。
- 不涉及 agent-engine JSONL 协议与运行包,无需 `pnpm agent:protocol`/`agent:build`。
- E2E 不执行,按约定默认无问题(如需执行会先征得许可)。
- 真实 Telegram 收发仍需你本地 `pnpm dev` 手动验收:添加 Bot → 启动 → 显示已启动 → Telegram 私聊可通;重启应用 → 渠道自动恢复;停止后重启不自启。