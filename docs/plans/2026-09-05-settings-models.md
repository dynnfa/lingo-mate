# Settings Models 配置计划

## 状态与目标

- 状态：已实施；2026-09-07 完成 Review 修复。单元/组件 302 项、集成 8 项通过，`pnpm lint`、`pnpm build`（含 typecheck）通过。Electron e2e 首跑 14/15 通过，动作菜单键盘用例单独重跑通过；未执行真实付费模型请求。
- 原始日期：2026-09-05；按当前设置页修订：2026-09-06。
- 当前基线：点击会话侧栏底部的设置图标后，应用切换到占满窗口的 Settings 页面；左侧为设置菜单，右侧为当前菜单项的详情。
- 目标：沿用现有 Settings 页面，在左侧新增“模型 / Models”菜单项，并在右侧详情区完成 LLM 配置、持久化、连接测试及真实对话接入。
- 关联文档：[Renderer 视图渲染模式](../architecture.md)、[国际化](./2026-09-04-i18n-internationalization.md)、[Vocabulary 多单词解析](./2026-09-05-vocabulary-batch-import.md)。

## 当前实现

- `src/renderer/src/App.tsx` 使用 `activeView: 'conversation' | 'settings'` 切换顶层视图，没有路由参与。点击设置图标后，对话视图通过 `hidden` 隐藏但保持挂载，同时挂载 `SettingsPage`；因此输入草稿、滚动位置和流式响应订阅不会丢失。
- `src/renderer/src/settings/SettingsPage.tsx` 已实现全窗口双栏页面：左侧约 220px 的菜单栏包含“返回”、页面标题和菜单项，右侧渲染所选区块。页面首次进入时聚焦“返回”，点击返回或按 Escape 退出，焦点随后回到原设置图标。
- 设置页内部同样使用 React 状态切换区块，不改变 URL。区块通过 `SETTINGS_SECTIONS` 注册表声明；当前仅有 `language`，每次重新进入 Settings 默认选中“语言 / Language”。
- `src/renderer/src/preferences/LanguagePreferenceSection.tsx` 是现有语言详情区块，负责读取、即时保存语言偏好及保存成功后的 i18n 切换。它不再承担弹窗或页面容器职责。
- `src/renderer/src/assets/main.css` 已提供设置页布局、选中态、详情滚动和 760px / 520px 响应式规则；右侧 `.settings-section-body` 当前最大宽度为 480px。
- `src/main/preferences-store.ts` 使用 `electron-store` 保存语言偏好，尚无模型配置或凭据存储。
- `src/core/llm/language-model.ts` 定义流式 `LanguageModel` 接口，`src/main/index.ts` 仍固定注入 `LocalLanguageModel`，目前只产生模拟回复。
- `package.json` 已包含 OpenAI SDK 与 Zod，但尚未接入真实模型。现有依赖不代表模型配置页面或远程调用已经完成。

## 首版范围与默认决策

1. 复用现有 `SettingsPage`，不恢复弹窗、不创建独立窗口、不引入 React Router，也不把菜单状态写入 URL。
2. 在 `SETTINGS_SECTIONS` 中把“模型 / Models”注册为“语言 / Language”之后的第二项。每次从设置图标进入时仍默认显示语言页；点击 Models 后仅替换右侧详情。
3. 设置页保持当前视觉层级、间距和响应式布局。Models 表单位于右侧现有 480px 内容列内；左侧继续使用当前选中态，不复制会话侧栏样式或加入额外顶栏。
4. 首版维护一套应用级 LLM 配置，协议采用 OpenAI Chat Completions 文本接口，手动填写 API 根地址 Base URL 和 Model ID。真实对话要求 SSE、`choices[].delta.content` 文本分片及 `finish_reason: stop` 正常结束；允许角色分片和 usage 等扩展字段。仅收到 `[DONE]`、连接提前结束、空回复或达到输出上限都不视为正常完成。不包含 Responses、其他厂商原生协议、工具调用或多模态，不承诺任意兼容服务均可工作。
5. 包含读取、编辑、保存、测试连接和清除配置。首版不做多提供方列表、多个模型档案、自动拉取模型目录、按任务分配模型或高级采样参数。
6. 完整交付必须让已保存配置用于真实对话，避免只保存表单却仍使用模拟模型。后续词汇分析复用同一配置来源，词汇业务本身按关联计划实施。

## 页面结构与交互

```text
Settings 页面（占满现有应用窗口）
┌──────────────────────┬──────────────────────────────────────────┐
│ ‹ 返回 / Back        │ 模型 / Models                            │
│ 设置 / Settings      │                                          │
│ ───────────────────  │ 配置用于语言学习的 LLM                   │
│ 语言 / Language      │                                          │
│ 模型 / Models        │ 接口类型   OpenAI-compatible             │
│                      │ Base URL   [                           ] │
│                      │ Model ID   [                           ] │
│                      │ API Key    [                           ] │
│                      │ 密钥状态   未配置 / 已配置                │
│                      │                                          │
│                      │ [测试连接] [保存] [清除配置]              │
│                      │ 保存状态 / 测试结果 / 字段错误            │
└──────────────────────┴──────────────────────────────────────────┘
```

以上是对当前页面的增量结构草图；页面没有弹窗遮罩、右上角关闭按钮或底部全局操作栏。所有静态文案从翻译资源获取。

| 字段     | 规则                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 接口类型 | 首版只展示支持的兼容接口类型，不提供尚未实现的选项                                                                                                               |
| Base URL | 必填，明确填写 API 根地址；校验 URL、规范化尾部斜杠，不静默重复添加路径；禁止 URL 内嵌用户名、密码、query 或 fragment；远程地址使用 HTTPS，本机回环地址允许 HTTP |
| Model ID | 必填，去除首尾空白，作为提供方模型标识原样传递；不硬编码可能失效的模型清单                                                                                       |
| API Key  | 密码输入框；只用于输入新密钥，不回填已存密钥；通过“保持 / 替换 / 移除”的明确操作表达更新意图；允许无需密钥的本地服务                                             |

- 首次切换到 Models 时读取安全配置摘要；加载中禁止提交。读取失败展示重试，不能将失败误判成首次未配置。
- 无有效修改时禁用保存。保存只做校验和持久化，不隐式发送模型请求；保存成功与连接测试成功分别展示。
- 保存失败保留草稿及原已保存配置，允许重试；成功后清空新输入的密钥，仅展示“已配置”状态。
- 在同一次 Settings 页面停留期间，从 Models 切到 Language 再切回时保留模型草稿。当前 `ActiveSection` 切换会卸载不同类型的区块，实施时需由 `SettingsPage` 承载模型草稿/状态，或保持区块挂载，不能依赖 `ModelsSettings` 的易失本地状态。
- Models 有未保存修改时，点击“返回”或按 Escape 均触发“继续编辑 / 放弃修改”确认；放弃或保存成功后才退出。退出 Settings 后清除 API Key 草稿。
- 切换菜单不是退出 Settings，不弹出放弃确认；若连接测试仍在执行，切离 Models 时中止该测试，但保留普通表单草稿。
- 测试连接使用当前表单草稿，不自动保存；使用固定的最小测试输入，不发送会话历史或学习记忆。按钮旁说明测试会发起请求，可能产生费用。
- 测试期间禁用重复测试及表单修改；切离 Models、退出 Settings 或窗口销毁时中止测试。测试结果区分成功、鉴权失败、模型不可用、超时、网络错误和不支持的响应协议；修改表单后清除旧测试结果。
- 清除配置需确认，成功后同时清除模型设置及密钥，回到未配置状态。失败时保留原状态。
- Models 菜单按钮沿用现有 `nav`、`button` 与 `aria-current` 语义。字段有 label，错误与字段关联，异步结果使用可访问的状态提示。
- 保留现有 900 × 670 窗口下的双栏布局；右侧详情独立滚动，所有操作在滚动后可达。760px 和 520px 断点继续保持双栏，不擅自改成弹窗或路由页。

## 设置页状态边界

Settings 页面与 Models 区块需要明确分工，避免模型表单破坏现有视图切换行为：

- `App` 继续只管理 `conversation` / `settings` 顶层视图以及返回后的焦点恢复，不持有模型字段或网络请求状态。
- `SettingsPage` 管理当前菜单项，并协调模型草稿是否脏、返回前确认、区块切换及测试取消。
- `ModelsSettings` 负责表单展示、字段级校验、保存/测试/清除操作和状态提示，通过明确 props 或专用 hook 与页面级草稿交互。
- `LanguagePreferenceSection` 保持现有“选择即保存”行为；语言切换不是 Models 草稿的保存动作，也不得重建 `ConversationController`。
- 退出 Settings 后页面整体卸载；再次从设置图标进入时默认回到 Language，并从 Main 重新读取模型摘要。

## 配置契约与凭据边界

在 `src/shared/models.ts` 集中定义 Zod schema、DTO、错误码及 `MODELS_CHANNELS`。业务校验和配置选择归 Core，存储与系统凭据能力由 Main 注入。

- 安全读取结果：`configured`、`protocol`、`baseUrl`、`modelId`、`hasApiKey`；未配置使用明确的判别联合，不以空字符串伪装有效配置。
- 保存输入：非敏感字段及 `credential` 判别联合：`keep`、`replace`（含本次输入的新值）、`remove`。不使用掩码字符串代表真实密钥，也不让空输入隐式删除密钥。
- 测试输入：草稿配置、凭据操作及 `requestId`；返回成功或稳定错误码，不返回提供方原始响应、请求头或密钥。
- 向 `LingoMateApi` 增加 `models`：`getSettings()`、`saveSettings(input)`、`testConnection(input)`、`cancelTest({ requestId })`、`clearSettings()`；同步更新 preload 实现和声明。
- channel 使用 `models:getSettings` 等稳定领域命名；Renderer 仅调用 `window.api.models`，不能直接访问网络模型客户端、Electron、数据库或文件系统。
- Main 验证输入和调用来源，preload 验证响应；校验错误只返回字段名和错误码，不回传包含密钥的输入或完整校验异常。

非敏感配置与加密后的密钥保存于应用用户数据目录下的独立模型配置记录，带 `schemaVersion`，不修改语言偏好或会话数据库。存储实现必须保证一次完整记录的原子替换；保存成功后再发布新的运行时配置，失败保留旧记录。

凭据加解密通过 Main 中的系统安全存储适配器完成，Core 只依赖窄接口。实施时确认目标平台安全存储能力；不可用或仅能提供明文级保护时明确返回 `CREDENTIAL_STORAGE_UNAVAILABLE`，不降级明文落盘。密钥解密失败需用户重新输入，不能静默当成无密钥配置。

已保存 API Key 不得从 Main/Core 发回 Renderer。用户在密码框中输入的新值只作为临时草稿单向提交，不写入 localStorage、全局持久化状态、日志或错误报告。包含真实凭据的运行时配置不得进入 Shared 响应 DTO。

更换 Base URL 的 origin 时，不允许将旧凭据通过 `keep` 自动发送给新地址，必须显式替换或移除凭据；测试与保存应用相同规则。模型客户端不得自动把鉴权头转发到跨 origin 的重定向目标。

## Core 接入与配置生效

1. 在 `src/core/llm` 定义模型配置服务、存储接口与远程 `LanguageModel` 适配器。Main 创建存储和凭据适配器，并将配置服务注入模型入口。
2. Main 不再固定创建生产用 `LocalLanguageModel`；每次新请求开始时取得已保存配置快照并创建或选择客户端。保存后下一次请求生效，不要求重启应用。
3. 已开始的流式请求继续使用自己的快照；修改或清除配置不打断在途生成。重试视为新请求，使用当时最新配置。
4. 未配置时返回明确的 `MODEL_NOT_CONFIGURED` 并提示前往 Settings > Models。保留历史会话读取能力；模拟模型仅作为显式开发模式或测试依赖，不在远程请求失败后自动回退。
5. 适配器保持既有流式完成、失败和取消语义，传递 `AbortSignal`，设置有限请求时限并忽略终态后的迟到结果；不因修改设置重建会话控制器或丢失消息状态。
6. 测试服务与真实调用共用配置校验和客户端构建逻辑。每窗口最多一个连接测试，默认 15 秒截止；结束、取消、窗口销毁时清理请求及计时器。测试成功只证明当次最小请求可用，不保证词汇结构化输出等其他能力。
7. 在实际发送的 Prompt 中分别指定语言：对话解释使用 Main 解析的当前界面语言，练习对话、例句和纠错句使用独立的 `targetLanguage`。当前尚无学习语言设置，首版会话显式传入英语 `en`，不随界面语言切换；本次不新增语言选择 UI。`src/core/prompt/conversation-prompt.ts` 负责语言指令，远程适配器负责协议转换。
8. 错误在产生处保留内部原因，进程边界仅传安全错误码；同步扩展会话错误映射及国际化提示，日志不得包含凭据、完整请求、会话或学习数据。

## 文件与职责

| 文件或目录                                                    | 计划变更                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/renderer/src/settings/SettingsPage.tsx`                  | 扩展现有区块注册表，加入 Models；协调菜单切换、草稿保留、返回确认与测试取消 |
| `src/renderer/src/settings/ModelsSettings.tsx`                | 新增右侧 LLM 配置区块，负责表单、字段校验和保存/测试/清除状态展示            |
| `src/renderer/src/preferences/LanguagePreferenceSection.tsx`  | 保持现有语言设置行为，作为新增菜单后的回归验证对象                          |
| `src/renderer/src/App.tsx`                                    | 原则上保持现有状态驱动视图切换；仅在错误引导或退出协议确有需要时做最小接线   |
| `src/renderer/src/assets/main.css`                            | 在现有设置页样式上增补模型表单、状态区、操作区及窄窗口布局，不重建弹窗样式   |
| `src/shared/models.ts`                                        | 新增配置协议、Zod schema、channel 与错误码                                  |
| `src/shared/conversation.ts`                                  | 向顶层 `LingoMateApi` 接入 `ModelsApi`，并补充必要的模型错误码              |
| `src/main/models-ipc.ts`                                      | 注册模型设置与连接测试的窄 IPC，校验调用来源并清理活动请求                  |
| `src/main/models-store.ts`                                    | 配置持久化、版本读取、原子替换与系统凭据加解密适配                          |
| `src/main/index.ts`                                           | 创建服务、注册 IPC、注入真实模型入口并处理窗口/应用生命周期                 |
| `src/preload/index.ts`、`src/preload/index.d.ts`              | 暴露并声明 `window.api.models`                                              |
| `src/core/llm/`                                               | 配置服务与接口、真实模型适配、连接测试、请求配置快照                        |
| `src/core/prompt/`、`src/core/conversation/`                  | 显式输出语言及模型配置错误与现有生成生命周期的衔接                          |
| `src/main/conversation-errors.ts`                             | 增加面向 Renderer 的安全模型错误映射                                        |
| `src/renderer/src/i18n/locales/{zh-CN,en}/`                   | 同步补齐 Models 菜单、表单、操作、确认、状态、无障碍和错误文本              |

文件名为实施建议；保持职责边界，避免为单一表单引入通用提供方插件框架。

## 实施步骤

- [x] 定义配置 DTO、凭据更新语义、稳定错误码和存储接口，明确首版支持的接口协议。（`src/shared/models.ts`：`MODELS_CHANNELS`、判别联合摘要、`credential` keep/replace/remove、`normalizeModelsBaseUrl`）
- [x] 实现配置读取、校验、原子保存与凭据保护，覆盖失败保留旧配置及跨 origin 凭据规则。（`src/core/llm/model-config.ts` + `src/main/models-store.ts`：临时文件 + rename 原子替换、safeStorage 加解密、损坏记录按读取失败处理）
- [x] 实现真实模型适配器、连接测试及取消，完成配置快照和输出语言传递。（`src/core/llm/remote-language-model.ts`、`model-connection-tester.ts`、`configured-language-model.ts`；`StreamReplyInput` 增加 `outputLanguage`）
- [x] 接通 Main、Shared 与 preload；替换生产对话的固定模拟模型，补齐未配置与调用失败提示。（`src/main/models-ipc.ts`、`window.api.models`；`LINGO_MATE_MODEL=local` 为显式开发/测试模式，未配置返回 `MODEL_NOT_CONFIGURED`）
- [x] 在现有 `SettingsPage` 注册 Models 区块，实现右侧配置表单、草稿跨菜单保留、返回确认、测试取消、双语及无障碍交互。（`useModelsSettings` 由 SettingsPage 持有；区块保持挂载用 `hidden` 切换）
- [x] 补齐必要测试，执行验证并回填实施结果。（shared/core/main 单元测试、`tests/integration/models-config.test.ts` 假服务集成、`tests/e2e/models-settings.test.ts` 全链路）

## 验证与验收

单元和组件测试放在对应模块的 `__tests__/` 下，集成测试放在 `tests/integration/`，Electron 端到端测试放在 `tests/e2e/`。

- Shared/Core：非法 URL、空模型标识、凭据保持/替换/移除、跨 origin 更新、未配置、配置快照隔离、显式输出语言、流式完成/失败/取消。
- Main/存储/IPC：重启恢复配置、读取损坏记录、持久化失败保留旧值、加解密不可用、密钥不回传、拒绝非法来源、测试超时与窗口销毁清理。
- Renderer：从设置图标进入独立 Settings 页面、默认显示 Language、菜单切换到 Models、当前语言功能回归、模型加载/失败/空状态、表单校验、保存与测试结果分离、模型草稿跨菜单保留、返回与 Escape 的未保存确认、清除配置、退出后焦点恢复、双语及键盘操作。
- 视图不变量：进入 Settings 后对话 DOM 保持挂载但不可见；切换 Language / Models 不影响会话控制器、未发送草稿、滚动位置或进行中的对话流；退出后再次进入默认回到 Language。
- 集成：用可控假服务验证“进入 Settings > Models → 填写 → 保存 → 返回对话 → 发消息使用配置 → 重启仍有效”，以及保存期间在途请求继续使用旧快照；默认测试不访问付费服务或依赖真实密钥。
- 手工验收：在当前 900 × 670 窗口以及 760px / 520px 断点核对双栏布局和详情滚动；在支持的真实服务上执行一次显式连接测试和流式对话，核对取消行为、密钥不回填以及文件/日志中无明文密钥。真实测试在实施阶段有可用凭据时进行，本计划不发起网络请求。

实施完成后运行：

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:electron
```

验收结果应满足：设置图标进入现有独立 Settings 页面；左侧在 Language 之后显示 Models；右侧可配置、测试、保存和清除 LLM；配置重启可恢复并对下一次请求生效；返回或 Escape 不会静默丢弃模型草稿；原语言设置、会话历史及生成生命周期正常；凭据与高权限能力不越过既定安全边界。


## Review 修复记录（2026-09-07）

- 远程生成使用覆盖请求和 SSE 消费全过程的截止时间；用户取消和超时分别处理，终态清理计时器及监听器。
- 校验 SSE 响应类型、消费的 chunk 字段、非空文本和正常结束标记；异常或截断回复不再作为成功消息保存。
- 所有 Models IPC 在访问配置或发送请求之前验证应用窗口、主 frame 和精确文档 URL；拒绝非可信来源。
- 已存密钥解密失败时阻止真实请求，保留内部原因并向界面传递安全错误码；支持直接移除无法解密的密钥。
- Prompt 分离解释语言与学习目标语言，实际发送的请求同时携带明确的两类语言指令。
- 保存成功后用 Main 返回的规范化摘要重置草稿；保存状态与连接测试结果分别显示。
- 新增回归测试覆盖以上失败路径；假服务补齐标准的 stop 分片，继续覆盖配置快照、取消和重启恢复。
