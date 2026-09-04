# i18n 国际化改造实施计划

## 状态与目标

- 状态：Implemented（2026-09-04 实施完成，验证见文末「实施记录」）。
- 首期语言：简体中文（`zh-CN`）和英文（`en`）。这是本计划的默认范围，后续语言按同一资源结构扩展。
- 目标：界面文案、状态提示、错误提示和日期显示随界面语言切换；偏好跨重启保留；离线可用。
- 基线：沿用现有 Electron → Core 调用关系及 Renderer → Preload → Main 安全边界，不改变会话生成、取消、重试和持久化语义。
- 关联计划：[持久会话与历史恢复](./2026-09-03-persistent-conversation-module.md)、[Canonical Message 与生成生命周期](./2026-09-03-canonical-message-lifecycle.md)。

## 现状与改造位置

| 位置                                                     | 当前情况                                                               | 改造方向                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `package.json`                                           | 未引入 i18n；已有 `electron-store`、Zod、Vitest 和 Playwright          | 增加 `i18next`、`react-i18next`，复用现有配置存储和测试工具 |
| `src/renderer/src/App.tsx`                               | 导航、空状态、按钮、输入提示、无障碍名称均为中文；设置按钮尚未接入功能 | 提取翻译资源，接入最小语言设置界面                          |
| 同文件的 `formatConversationLabel`                       | 拼接中文，日期和时间未传 locale                                        | 翻译完整模板，显式传入当前界面 locale                       |
| `conversation-state.ts`                                  | `statusMessage: string` 保存翻译后的中文                               | 改存语义状态或错误描述，渲染时翻译                          |
| `conversation-controller.ts`                             | 多个 `GENERIC_*_ERROR` 中文常量，直接传递 `error.message`              | 改为类型化状态和错误，不依赖翻译实例                        |
| `src/shared/conversation.ts`                             | 请求错误及流事件错误均包含 `code + message`                            | 协议只表达安全错误语义，去除展示文案                        |
| `src/main/conversation-errors.ts`、`conversation-ipc.ts` | 构造中文错误；会话和消息不存在共用 `NOT_FOUND`                         | 保留错误码，并用受约束字段区分对象                          |
| `src/core/conversation/conversation-module.ts`           | `toSafeError` 构造中文生成失败提示                                     | 返回安全错误码，Core 不负责界面翻译                         |
| `src/renderer/src/main.tsx`、`src/renderer/index.html`   | 直接挂载 App；HTML 没有 `lang`，标题为 Electron                        | 初始化语言后挂载，设置 `lang`、`dir` 和产品标题             |
| 现有组件、状态及 Electron 测试                           | 大量断言中文文案和中文 accessible name                                 | 固定测试语言，增加真实中英文资源与切换验证                  |

实施时以最新工作区为准，尤其保留正在调整的侧栏、工具栏和布局测试行为。

## 范围

首期包含当前 React 页面全部产品文案、状态及安全错误提示、语言选择、系统语言初始匹配、偏好持久化、日期格式化、无障碍属性和双语布局验证。

界面语言独立于学习目标语言、用户母语和模型回复语言。切换界面时，不翻译历史消息、用户输入或模型输出，不改 Prompt、消息 ID、数据库内容和正在运行的生成请求。`LocalLanguageModel` 的中文示例回复属于开发模型输出，本期保持原样；它不作为英文界面文案遗漏。

本期不新增其他语言、RTL 布局、翻译平台、远程语言包、多窗口实时同步或完整设置中心。项目目前没有自定义原生菜单、托盘或对话框文案；Electron/操作系统默认菜单不纳入 React 语言切换承诺，后续新增应用自定义原生文案时再接入 Main 专用翻译实例。日志、代码注释和开发异常消息不作为产品翻译资源。

## 设计决定

### 1. 使用 i18next 与 react-i18next

Renderer 使用 `i18next` 管理资源、语言与回退，通过 `initReactI18next` 和 `useTranslation` 接入 React；实现前确认与项目 React 19、TypeScript 5.9 兼容的版本并锁定到 lockfile。接入方式参考 [react-i18next 官方快速入门](https://react.i18next.com/guides/quick-start)。

中英文资源静态打包，启动时在内存中初始化，不引入 HTTP backend 或浏览器语言探测插件。语言来源由 Main 统一解析，避免浏览器缓存与桌面偏好形成两套来源。i18next 支持通过 `resources` 直接初始化，参考[配置文档](https://www.i18next.com/overview/configuration-options)。

建议资源与模块位置：

```text
src/shared/preferences.ts                      # locale 枚举、偏好 IPC 协议和 Zod schema
src/main/preferences.ts                        # 偏好读取、校验、系统语言解析及存储
src/main/preferences-ipc.ts                    # 窄接口和安全错误转换
src/renderer/src/i18n/
├── index.ts                                   # 创建/初始化 i18next 实例
├── i18next.d.ts                                # 资源 key 类型声明
├── formatters.ts                              # 显式 locale 的 Intl 格式化
├── locales/
│   ├── zh-CN/{common,conversation,errors}.json
│   └── en/{common,conversation,errors}.json
└── resources.test.ts                          # key、占位符及资源完整性
src/renderer/src/preferences/LanguageSettings.tsx
```

这是建议文件布局，可按实际实现合并小模块；不建立通用插件系统或翻译服务层。Shared 仅承载可序列化类型、schema 与 IPC 常量，翻译实例和资源留在 Renderer。

资源使用语义 key，例如 `common:actions.cancel`、`conversation:status.generating`、`errors:conversationNotFound`，不以中文原句作为 key。用完整句子配合命名插值，避免拼接词语；将来有数量文案时使用复数规则。当前没有需求时不添加虚构的计数功能。

通过 `CustomTypeOptions` 关联资源类型，使拼错 key 在类型检查阶段暴露；动态状态映射使用穷尽的显式映射，不使用任意字符串断言绕过校验。参考 [i18next TypeScript 文档](https://www.i18next.com/overview/typescript)。

### 2. 语言偏好与持久化

```ts
type SupportedLocale = 'zh-CN' | 'en'
type LocalePreference = 'system' | SupportedLocale

interface LocaleSettings {
  preference: LocalePreference
  resolvedLocale: SupportedLocale
}
```

选择项显示为“跟随系统 / System”“简体中文”“English”；语言自身名称保持固定，便于用户从陌生界面切回。未保存偏好等同于 `system`。

解析顺序：

1. 已保存的明确语言优先。
2. `system` 时，由 Main 在 `app.whenReady()` 后读取 `app.getPreferredSystemLanguages()`，按系统偏好顺序匹配支持语言。
3. `en` 及其地区变体映射到 `en`；`zh`、`zh-CN`、`zh-SG`、`zh-Hans` 及其地区变体映射到 `zh-CN`。
4. 繁体中文变体暂不宣称支持，继续匹配后续系统偏好；无匹配或读取失败则回退 `zh-CN`，保持当前中文默认体验。

以标准语言标签解析器处理大小写、地区和脚本，非法标签跳过；不用简单的 `startsWith('zh')` 将繁体误判为已支持的简体。Electron 提供系统偏好语言列表，参考 [app API](https://www.electronjs.org/docs/latest/api/app#appgetpreferredsystemlanguages)。

只持久化 `preference`，不持久化系统解析结果。复用已安装的 `electron-store`，由 Main 保存到应用用户数据目录；不为语言设置修改 SQLite schema。读取到非法字段时使用 `system`，存储读写异常应转换为安全错误，不能悄悄宣称保存成功，也不能清空其他配置。存储依赖可注入，以便在测试中隔离真实用户数据。

第一版在启动及用户选择“跟随系统”时重新解析系统语言；应用运行期间不自动监听 OS 语言变化。

### 3. 保持窄 IPC 边界

增加以下业务接口，IPC channel 集中在 Shared：

```ts
window.api.preferences.getLocale()
window.api.preferences.setLocale({ preference })
```

两者返回可序列化的成功/失败判别联合：成功包含 `LocaleSettings`，失败包含安全错误码，如 `PREFERENCES_READ_FAILED`、`PREFERENCES_WRITE_FAILED`、`INVALID_LOCALE`。Main 和 Preload 校验输入、返回值；持久化值也需校验。

同步更新 `LingoMateApi`（当前定义于 `src/shared/conversation.ts`）、`src/preload/index.ts` 和 `src/preload/index.d.ts`，以及所有完整 API mock。保持现有 conversation API 不变；不为本改造引入通用 `invoke`、任意配置键或文件路径访问接口。

### 4. 启动与运行时切换

- 首次 React 挂载前获取偏好并完成 i18next 初始化，避免先渲染中文再跳到英文。
- 偏好 IPC 拒绝、返回非法数据或超时后，使用打包的 `zh-CN` 资源继续启动，并显示可理解的偏好读取失败提示；启动读取使用有界等待（建议 3 秒），忽略过期响应。
- `index.html` 提供默认 `lang="zh-CN"` 和产品标题 `Lingo Mate`；成功初始化后同步 `document.documentElement.lang` 与 `dir`。两种首期语言均为 `ltr`。
- 复用现有设置按钮打开只包含语言选择的轻量设置面板，补齐键盘操作、关闭及焦点返回行为。
- 用户选择语言后，等待 Main 校验并保存成功，再按返回的 `resolvedLocale` 调用 `changeLanguage`；保存期间禁用重复提交，失败时保留原语言并提示。
- 语言切换不重新挂载 App 或创建 `ConversationController`，不重新订阅会话事件，不清空 draft，不取消生成；设置面板在生成期间仍可使用。

### 5. 状态和错误保留语义，展示时翻译

`statusMessage: string` 改成 Renderer 内部的判别联合，覆盖恢复、切换、创建、就绪、生成、完成、取消、协议异常和错误状态。Reducer、Controller 只存状态及安全错误信息，组件在每次 render 时调用翻译。因此，即使当前没有新事件，切换语言也能更新已有的完成、取消和失败提示。

错误协议处理：

- 请求错误及生成错误保留现有 code，移除 `message` 字段；同步修改 Shared schema、Main、Core、安全映射与调用方，不能只改 React。
- `NOT_FOUND` 增加受 Zod 约束的 `resource: 'conversation' | 'message'` 判别信息，保留两种错误的具体含义；不传任意业务对象或内部异常。
- Controller 的 IPC Promise 拒绝分别映射到加载、刷新、发送、取消和重试失败等本地语义错误。
- `PERSISTENCE_ERROR` 默认使用通用的本地会话读写失败提示；已有上下文足以区分时，由展示映射细化，不依据旧中文字符串判断。
- 未识别的边界数据进入本地协议/通用错误路径；不将服务端原文、堆栈、路径或内部原因直接显示给用户。
- 内部异常原因继续留在产生处，Core 不导入 i18next、React 或 Renderer 模块。

本地 Main/Preload/Renderer 随同一安装包升级，一次性完成协议迁移。错误提示目前不是持久消息字段，无需改写 SQLite 历史数据，也不保留长期的中英文双协议兼容分支。

### 6. 日期、文案与布局

- 用 `Intl.DateTimeFormat(resolvedLocale, options)` 格式化现有 `updatedAt`，保持本地时区语义；将结果传入完整翻译模板，如 `Conversation · {{dateTime}}`。
- 不修改存储中的 ISO 时间；未来数字与相对时间也使用显式 locale 的 `Intl` 格式化器。
- 提取可见文案以及 `aria-label`、`title`、placeholder、表单 label；`Lingo Mate` 品牌名与装饰符号保持原样。
- 用户输入、消息正文及插值以 React 文本节点呈现，不使用 `dangerouslySetInnerHTML`。仅当保持这条渲染约束时使用适合 React 的 `escapeValue: false`。
- 中英文分别验证 900px、620px 窗口宽度，重点检查侧栏菜单、语言选择、日期、输入栏按钮与长错误提示；允许合理换行，避免按钮或输入区域被挤出。

## 实施步骤

### Phase 1：资源与初始化基础

- [ ] 安装并锁定 `i18next`、`react-i18next`。
- [ ] 建立两个 locale、三个 namespace、资源类型声明与格式化函数。
- [ ] 明确 `supportedLngs` 与 `fallbackLng: 'zh-CN'`，使用本地打包资源。
- [ ] 为测试提供独立 i18next 实例工厂，避免共享语言状态污染用例。

### Phase 2：偏好纵向接入

- [ ] 实现 Main 偏好服务、系统语言解析、注入式存储及错误处理。
- [ ] 增加 Shared schema、集中 channel 和 Preload 窄接口，同步全量 API mock。
- [ ] 实现启动读取、超时回退、HTML 语言属性，以及最小语言设置面板。
- [ ] 验证选择语言、保存成功后生效、保存失败保留原值、重启恢复。

### Phase 3：状态与安全错误迁移

- [ ] 同步修改请求及流式错误 schema、`toSafeRequestError`、IPC 内直接构造的错误和 Core `toSafeError`。
- [ ] 将 reducer/controller 的文案状态改为语义描述，补足错误到翻译 key 的穷尽映射。
- [ ] 更新协议、Core、Main 和状态测试断言，保持原有生成生命周期行为。

### Phase 4：界面资源替换

- [ ] 提取 App 中所有产品文案和无障碍文案，接入 `useTranslation`。
- [ ] 使用明确 locale 格式化会话日期，检查两个语言版本的表达与布局。
- [ ] 确认切换时输入草稿、活动会话、canonical IDs 和流式输出保持连续。

### Phase 5：回归与交付

- [ ] 资源测试检查双语 key 集合、非空译文及插值参数一致；缺失 key 不仅靠运行时回退掩盖。
- [ ] 更新现有测试的语言初始化，增加 Electron 双语及重启测试。
- [ ] 检查源码中文命中，人工区分产品文案、日志、注释、模型输出和测试样本。
- [ ] 运行验证命令，记录结果及受环境限制未完成的项；仅通过后将计划状态改为 Implemented。

## 测试与验收

| 层级                    | 关键场景                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| 偏好单元测试            | 无配置、明确选择、跟随系统、按偏好顺序匹配、语言变体、非法标签、无支持语言、读取失败、写入失败       |
| Shared / Main / Preload | 非法输入被拒绝；未知结果不直接使用；错误载荷无内部原因；renderer 仍无 Electron/Node 原始能力         |
| 资源与类型              | 中英文 key 与插值一致；错误映射完整；拼错 key 无法通过类型检查；指定回退行为正确                     |
| 状态与 Controller       | 断言语义状态，覆盖启动、切换、发送、完成、取消、失败及重试；原有乱序和 stale event 测试继续通过      |
| React 组件              | 使用真实资源和独立 provider；中英文关键文案与 accessible name 正确；保存失败、启动拒绝/超时可恢复    |
| 运行中切换              | draft 不丢失；controller/订阅不重建；生成不中断；已有错误和终态提示立即换语言                        |
| Electron                | 选择英文后关闭重启仍为英文；切回中文；历史消息内容与 ID 不变；两种语言完成发送、取消、重试和恢复流程 |
| 日期与布局              | 测试固定时间与时区；英文日期随 locale 更新；900px、620px 无水平溢出或不可操作控件                    |

既有中文交互测试显式设置 `zh-CN`，不能依赖开发机系统语言。国际化组件测试不得只 mock `t(key) => key`；保留对真实可访问名称的验证。Electron 测试使用独立临时 userData，避免修改个人配置或被旧偏好影响。

实施完成后运行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:electron
```

最终验收标准：

- [x] 中文、英文可无刷新切换，手动选择跨重启保持，默认跟随系统且回退确定。
- [x] 当前页面全部产品文案和无障碍名称具备两种语言，日期遵循选择语言。
- [x] 切换时状态提示立即变化，用户内容、消息 ID、草稿及生成生命周期不受影响。
- [x] Core 和 Main 的会话错误协议不再携带展示文案，Renderer 不直接显示底层异常。
- [x] 离线启动不依赖语言包网络请求，偏好读取失败不会导致白屏或永久加载。
- [x] 新增语言可通过资源和受支持 locale 配置接入，无需复制业务组件。
- [x] 原有会话及进程隔离测试通过，新增双语、资源完整性、偏好持久化和布局验证通过。

## 实施记录（2026-09-04）

按计划五个阶段完成，模块位置与上文建议一致。验证结果：

```bash
pnpm lint           # 0 errors 0 warnings
pnpm typecheck      # node + web 均通过
pnpm test           # 16 个文件 168 个用例全部通过
pnpm build          # 通过
pnpm test:electron  # 11 个用例全部通过（含 3 个语言切换新用例）
```

实施要点与偏差说明：

- **electron-store CJS 互操作**：v11 为纯 ESM 包，主进程 CJS 产物经打包器 `_interopNamespaceDefault` 包装后构造函数位于 `ns.default.default`，而 ESM 直载时位于 `ns.default`；`src/main/preferences-store.ts` 的 `resolveStoreConstructor` 显式兼容两种形态。偏好文件为 userData 下的 `preferences.json`（仅 `localePreference` 一个键）。
- **偏好初始化不阻断启动**：`src/main/index.ts` 中偏好注册包在 try/catch 内，存储初始化失败只损失语言记忆，Renderer 按启动流程回退 `zh-CN` 并展示可关闭的提示，与验收标准一致。
- **遗留修复**：`message-lifecycle.pw.ts` 原先断言不存在的 `#conversation` DOM 元素（基线即失败），改为通过 `window.api.conversation.list()` IPC 读取当前会话。
- **语言名称固定不翻译**：设置面板内 `跟随系统 / System`、`简体中文`、`English` 为刻意保留的固定字面量，不进入翻译资源；除此之外 Renderer/Main 源码无硬编码产品文案（中文命中检查已完成，其余命中均为注释、日志与测试数据）。
- `LocalLanguageModel` 的中文示例回复为开发模型输出，按计划范围保持原样。
