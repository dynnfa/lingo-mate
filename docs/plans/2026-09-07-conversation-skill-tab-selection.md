# Conversation Slash Skill 支持 Tab 选择计划

- 日期：2026-09-07
- 状态：待实施；本次仅编写计划。

## 目标

在 conversation 输入框中输入以半角 `/` 开头的内容，候选列表命中现有功能时，按 Tab 与按 Enter 一样选中当前高亮的 skill。选择后补全命令并保留输入框焦点，用户可以继续输入参数；本次按键不发送消息，也不执行 skill。

例如：输入 `/voc` → 出现并高亮「收藏词汇」→ 按 Tab → 输入框变为 `/vocabulary `，候选列表关闭，继续输入词汇后按现有提交方式执行。

## 当前实现

- `src/renderer/src/conversation/conversation-actions.ts` 定义现有候选目录，以及 `/` 触发和过滤规则。当前按命令名或当前界面的本地化名称做不区分大小写的子串匹配；输入 `/` 展示全部候选。
- `src/renderer/src/conversation/ConversationPanel.tsx` 管理候选列表、当前高亮、焦点和关闭状态。未主动高亮时默认选择过滤结果的第一项。
- `handleInputKeyDown` 中，Enter 阻止默认提交并调用 `selectAction`；Tab 当前只调用 `closePicker('soft')`，允许焦点按 DOM 顺序移出。
- `selectAction` 填入 `/<command> `，关闭候选列表并保持输入焦点；`vocabulary` 还会设置 `selectedSkillId`。应复用此入口，保证 Tab 选择后仍走现有 skill 提交流程。
- `src/renderer/src/conversation/__tests__/ConversationPanel.test.tsx` 已覆盖 Enter 选择、Tab 关闭、空匹配、输入法组合和关闭后重开等行为。

本计划中的 skill 选择沿用现有行动候选目录及 Enter 的选择语义，不扩展目录、匹配算法或后端能力。

## 交互规则

| 场景                                                                | Tab 行为                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 候选列表打开且有匹配项                                              | 阻止默认焦点跳转，选中当前高亮项；没有主动高亮时使用现有默认第一项 |
| 输入 `/`，展示全部候选                                              | 按现有 Enter 规则选中当前高亮项                                    |
| 使用上下方向键或鼠标悬停更改高亮                                    | 选择更改后的高亮项，不强制选第一项                                 |
| 候选列表打开但无匹配项                                              | 不选择、不发送，保留草稿；沿用关闭列表并允许默认焦点跳转的行为     |
| 候选列表未打开，包括普通文本、已选择命令后的参数输入、Escape 关闭后 | 保留默认焦点导航，不补全或提交                                     |
| Shift+Tab                                                           | 保留反向焦点导航；列表打开时按现有方式关闭，不选择 skill           |
| Ctrl / Alt / Meta 与 Tab 组合                                       | 不触发 skill 选择，不阻止系统或浏览器快捷键                        |
| 输入法组合期间                                                      | 沿用现有组合输入保护，不选择、不发送，不拦截输入法按键             |
| 输入框锁定                                                          | 不触发候选选择，沿用现有禁用状态                                   |

选择成功后的行为与 Enter 保持一致：

1. 填入完整命令并保留一个尾随空格。
2. 复用 `selectAction` 更新 skill 选择状态，尤其是 `vocabulary` 的类型化状态。
3. 使用现有 `latched` 关闭状态，避免列表在选择完成或普通重渲染后立即重开。
4. 焦点留在输入框；再次按 Tab 时因列表已关闭，正常移出焦点。
5. 不调用 `onSend` 或 `onRunSkill`；后续输入参数与提交遵循现有流程。

Enter 在候选列表打开但无匹配项时仍阻止提交；Tab 在该场景仍允许移出焦点。两者只在有效候选的选择结果上保持一致。

## 实施步骤

1. 修改 `ConversationPanel.tsx` 的 Tab 分支：在输入法与列表打开状态的现有保护之后，判断是否为不带修饰键的 Tab，查找当前高亮候选；找到时调用 `preventDefault()` 和现有 `selectAction`。保留无候选及 Shift+Tab 的关闭与焦点导航行为。
2. 保持 Enter、方向键、Escape 的行为，更新将 Tab 一概描述为关闭操作的注释。不引入全局快捷键、新状态或第二套 skill 选择实现。
3. 更新现有「Tab 不选择」测试，将其限定为无匹配项或 Shift+Tab 场景；增加以下组件回归用例。
4. 本次不增加静态界面文案；如实施时增加快捷键提示，应通过 i18n key 同步更新 `zh-CN` 和 `en` 资源。

改动仅涉及 Renderer 键盘交互及对应测试，无需修改 Core、Main、Preload、数据库或 Prompt。

## 验证与验收

- 对 Enter 与 Tab 参数化验证：部分命令匹配、完整命令匹配、仅 `/`、本地化名称匹配都选中相同候选，草稿、关闭状态和焦点一致。
- 多候选场景经方向键或鼠标更改高亮后，Tab 选中正确项。
- Tab 选择 `/vocabulary` 时不执行 skill；补充词汇并提交后，调用 `onRunSkill` 的参数与 Enter 选择后的参数一致。
- 成功选择时键盘事件被阻止默认行为，`onSend` 和 `onRunSkill` 均未触发；列表不会因重渲染或重新聚焦立即重开。
- 无匹配项、普通文本、列表已关闭、Shift+Tab 和其他修饰键组合不触发选择；应允许导航的事件未被 `preventDefault`。
- 同时覆盖组件组合输入状态和原生 `isComposing` 保护；输入锁定时不能选择。
- 保留并通过现有 Enter、Escape、发送保护和语言切换测试。
- 使用真实浏览器或 Electron 手动验证成功选择后焦点保留、第二次 Tab 正常移出，以及无匹配项和 Shift+Tab 的实际焦点顺序。jsdom 的 `fireEvent.keyDown` 不执行原生 Tab 导航，不能仅凭该事件断言真实焦点跳转。

实施后运行：

```bash
pnpm test src/renderer/src/conversation/__tests__/ConversationPanel.test.tsx
pnpm lint
pnpm typecheck
pnpm build
```

验收标准：用户在现有 `/` 候选列表中按 Tab，即可获得与 Enter 相同的选择结果并继续输入参数，且不误发送消息、不影响上述焦点导航场景。
