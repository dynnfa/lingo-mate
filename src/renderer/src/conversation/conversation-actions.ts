// `/` 行动选择器的展示元数据与纯函数：只描述稳定身份与文案 key，
// 不包含 Prompt、业务执行逻辑或跨进程协议；词汇行动由独立录入模式执行。

export type ConversationActionId = 'translate' | 'polish' | 'practice' | 'vocabulary'

// 文案 key 显式枚举：类型以 zh-CN 资源为基准，拼错在类型检查阶段暴露，
// 双语 key 集合一致性由 resources.test.ts 保证。
export type ConversationActionTextKey =
  | 'conversation:actionPicker.actions.vocabulary.name'
  | 'conversation:actionPicker.actions.vocabulary.description'
  | 'conversation:actionPicker.actions.translate.name'
  | 'conversation:actionPicker.actions.translate.description'
  | 'conversation:actionPicker.actions.polish.name'
  | 'conversation:actionPicker.actions.polish.description'
  | 'conversation:actionPicker.actions.practice.name'
  | 'conversation:actionPicker.actions.practice.description'

export interface ConversationActionMeta {
  // 稳定行动 ID：高亮身份与选择结果的协议字段，不随界面语言变化。
  readonly id: ConversationActionId
  // 稳定命令名（不含斜杠）：展示为 /command，并参与过滤。
  readonly command: string
  readonly nameKey: ConversationActionTextKey
  readonly descriptionKey: ConversationActionTextKey
}

// 首版行动目录：数组顺序即展示顺序，过滤结果沿用该顺序。
export const CONVERSATION_ACTIONS: readonly ConversationActionMeta[] = [
  {
    id: 'translate',
    command: 'translate',
    nameKey: 'conversation:actionPicker.actions.translate.name',
    descriptionKey: 'conversation:actionPicker.actions.translate.description'
  },
  {
    id: 'polish',
    command: 'polish',
    nameKey: 'conversation:actionPicker.actions.polish.name',
    descriptionKey: 'conversation:actionPicker.actions.polish.description'
  },
  {
    id: 'practice',
    command: 'practice',
    nameKey: 'conversation:actionPicker.actions.practice.name',
    descriptionKey: 'conversation:actionPicker.actions.practice.description'
  },
  {
    id: 'vocabulary',
    command: 'vocabulary',
    nameKey: 'conversation:actionPicker.actions.vocabulary.name',
    descriptionKey: 'conversation:actionPicker.actions.vocabulary.description'
  }
]

// 仅半角 `/` 作为首字符触发；不做 trim，前导空格与全角斜杠都不算。
// 返回值为 `/` 之后的查询词，不符合前缀时为 undefined。
export function parseSlashTrigger(draft: string): string | undefined {
  return draft.startsWith('/') ? draft.slice(1) : undefined
}

// 查询为空展示全部；否则按稳定命令名与当前界面本地化名称做不区分大小写的
// 子串过滤，顺序沿用传入的行动目录。resolveName 由调用方传入以保持本函数纯净可测。
export function filterConversationActions(
  actions: readonly ConversationActionMeta[],
  query: string,
  resolveName: (action: ConversationActionMeta) => string
): ConversationActionMeta[] {
  const needle = query.toLowerCase()
  if (needle === '') return [...actions]
  return actions.filter(
    (action) =>
      action.command.toLowerCase().includes(needle) ||
      resolveName(action).toLowerCase().includes(needle)
  )
}
