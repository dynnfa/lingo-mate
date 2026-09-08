# 语言设置菜单重构计划

- 日期：2026-09-08
- 状态：待实施

## 目标与范围

将设置页左侧现有的「语言」菜单拆为两个同级菜单：`uiLanguage`（界面语言）和 `targetLanguage`（目标学习语言），各自显示对应的设置内容并独立保存。

本次建立两种语言的明确配置边界，并让学习流程读取目标语言配置。解释语言继续跟随界面语言，不新增第三个设置项。

当前学习能力仅支持英语。本计划默认目标语言首版仅提供 English，并显示已国际化的「目前支持英语」说明；不以新增菜单为由直接开放未经适配的语言。新增日语、中文等学习语言属于后续能力扩展，需要同步调整词汇协议、Prompt、规范化和存储查询等逻辑。

## 当前代码基线

- `src/renderer/src/settings/SettingsPage.tsx`：左侧注册 `language` 菜单，右侧显示 `LanguagePreferenceSection`。
- `src/renderer/src/preferences/LanguagePreferenceSection.tsx`：支持跟随系统、中文、English，保存成功后调用 i18next 切换界面。
- `src/shared/preferences.ts`：只有 `LocaleSettings` 和 `getLocale` / `setLocale` 协议，没有目标学习语言设置。
- `src/main/preferences-store.ts`：通过 electron-store 的 `preferences` 文件保存 `localePreference`。
- `src/main/index.ts`：从界面语言解析模型解释语言。
- `src/core/conversation/conversation-module.ts`：解释语言通过依赖注入取得，`targetLanguage` 写死为 `en`。
- `src/core/prompt/conversation-prompt.ts` 和 `word-concept.ts`：已分别指定解释语言与目标语言。
- `src/shared/vocabulary.ts`、`src/shared/conversation.ts` 及词汇分析流程：`wordLanguage` 限定为 `en`，词汇 Prompt 也限定英语。

## 页面结构与交互

```text
设置
├── 界面语言           uiLanguage
├── 目标学习语言       targetLanguage
├── 模型               保留现有入口
└── 其他现有设置       保留现有顺序
```

1. 进入设置页默认选中 `uiLanguage`，沿用现有左右分栏布局。
2. 「界面语言」提供跟随系统、简体中文、English，选择成功后立即切换界面，保留当前页面、会话和输入草稿。
3. 「目标学习语言」显示当前目标语言，首版为 English；不提供「跟随系统」，避免学习目标随系统变化。
4. 两个菜单分别展示选择、保存中和失败状态。写入失败保留原值，提示使用当前 UI 语言。
5. 切换目标语言不调用 i18next，不改变界面或解释语言；切换界面语言不改写目标语言。
6. 菜单名称、说明、语言选项、错误提示和无障碍标签统一使用翻译 key，中英文资源同步更新。语言自称可保持固定显示，但仍通过资源管理。
7. 保留设置页已有退出确认、键盘操作、焦点和隐藏模型草稿的行为。

## 配置模型与默认值

明确区分 UI 语言与学习语言的类型，避免将二者绑定到同一份支持列表。

```ts
type UiLanguagePreference = 'system' | 'zh-CN' | 'en'
type TargetLanguage = 'en' // 首版能力范围；新增值须完成学习能力适配

interface LanguageSettings {
  uiLanguage: UiLanguagePreference
  resolvedUiLanguage: 'zh-CN' | 'en'
  targetLanguage: TargetLanguage
}
```

- 持久化 `uiLanguage` 与 `targetLanguage`，`resolvedUiLanguage` 由 Main 解析，不存储系统解析结果。
- 新安装默认 `uiLanguage: 'system'`、`targetLanguage: 'en'`；系统语言匹配和简体中文回退规则沿用现有逻辑。
- 解释、反馈和词义使用 `resolvedUiLanguage`；练习对话、例句和纠正后的句子使用 `targetLanguage`。

## 实施步骤

### 1. 扩展 Shared、Main 与 Preload

- 在 `src/shared/preferences.ts` 定义语言设置、独立更新输入、返回结果和 Zod 校验。目标语言使用明确的支持枚举，不接受任意字符串。
- 提供面向业务的 `getLanguageSettings`、`setUiLanguage`、`setTargetLanguage` API，并集中声明对应 IPC channel。
- 独立更新只修改对应字段；Main 返回完整的已生效设置，避免界面使用未确认值。
- 在 PreferencesService 中实现读取、默认值、写入和迁移；保持存储依赖可注入。
- 同步更新 `src/preload/index.ts`、`src/preload/index.d.ts`、启动语言加载及所有旧 API 调用点。迁移存量配置后无需长期保留重复 API。
- Main 校验输入并转换安全错误；Renderer 只通过 `window.api.preferences` 访问设置。

### 2. 迁移已有配置

- 优先读取合法的新 `uiLanguage`；没有合法新值时，从旧 `localePreference` 迁移；两者都不可用时采用 `system`。
- 缺失或非法的存储目标语言回退 `en`；来自 IPC 的非法更新则明确拒绝，不静默接受。
- 新字段保存成功前保留旧字段，迁移失败不丢失已有语言偏好；重复启动不覆盖已经保存的新设置。
- 本阶段不改写历史会话、已保存的词义解释或学习记录，也不需要 SQLite schema 迁移。

### 3. 拆分设置菜单与组件

- 将 `SettingsPage` 的 `language` 菜单替换为 `uiLanguage` 和 `targetLanguage`，默认选中项同步更新。
- 将现有语言组件调整为界面语言组件，新增目标学习语言组件；沿用现有选择即保存的交互，不引入全页保存按钮。
- 更新启动 locale 读取逻辑，由 `resolvedUiLanguage` 初始化 i18next。
- 为两个菜单和对应内容补充中英文翻译资源、稳定的标题关联及选中状态。

### 4. 将目标语言配置接入学习流程

- Main 提供语言设置解析依赖，Core 不直接读取 electron-store。
- 每次新执行开始时取得解释语言和目标语言快照，并在同一次执行的模型调用、工具分析及反馈中保持一致；设置变更不影响在途请求。
- 普通对话和单词概念解释从快照传入 `targetLanguage`，移除对话模块中的固定 `en`。
- 词汇操作的 `wordLanguage` 来源于目标语言快照。同步检查 Renderer 构造技能参数的路径，并由 Main/Core 校验，避免客户端旧值与当前设置冲突。
- 首版继续保留英语词汇能力的严格校验；Prompt 必须明确自然语言字段的输出语言，协议字段名和枚举保持稳定。
- 已持久化的技能执行重试使用原有执行参数和解释语言；普通回复重试作为新执行读取当前设置。后续增加目标语言时，需为持久化执行补齐语言快照迁移。

### 5. 验证与回归

- Shared/Main 单元测试：新默认值、旧配置迁移、新字段优先、迁移幂等、非法输入拒绝、存储失败、独立字段更新及系统语言解析。
- Renderer 组件测试：两个同级菜单、默认选中、设置读取、保存与失败状态、中英文标签，以及切换 UI 后页面和草稿保留。
- Core 测试：模型请求明确携带两种语言，UI 切换不改变目标语言，在途执行保持快照，普通回复与技能重试遵循上述规则。
- 回归词汇分析、启动语言初始化和设置页隐藏模型草稿的退出确认。
- 测试按项目规范放在模块 `__tests__/` 中；跨模块测试放在 `tests/integration/`。

## 验收标准

- 设置页有两个独立菜单「界面语言」和「目标学习语言」，不再保留含义模糊的单一「语言」入口。
- 旧用户升级后保留原界面语言，默认学习英语；重启后两个设置均可正确读取。
- UI 与目标语言有独立类型、配置字段和更新 API，更新一项不会覆盖另一项。
- 解释语言跟随 UI，目标语言从配置进入实际学习请求；首版明确只支持英语。
- 保存失败不造成界面与已生效设置不一致；切换设置不丢失会话或草稿。
- 所有新增静态文本完成中英文国际化，Renderer 不绕过 Preload 安全边界。

实施后运行相关测试及 `pnpm lint`、`pnpm typecheck`、`pnpm build`，再通过 `pnpm dev` 手动检查菜单、即时语言切换和重启恢复。本次仅编写计划，不执行功能修改与构建测试。
