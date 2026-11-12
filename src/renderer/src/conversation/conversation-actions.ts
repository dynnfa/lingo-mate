import type { ConversationSkillId } from '../../../shared/conversation'
import { splitConversationCommand } from '../../../shared/conversation-command'

// 选择器仅负责命令补全和草稿提示。命令原文统一提交给对话入口。
export type ConversationActionId = ConversationSkillId | 'concept'
export type SelectedConversationSkillId = ConversationSkillId

export function isSelectedSkillDraft(
  draft: string,
  selectedSkillId: SelectedConversationSkillId | null
): boolean {
  return selectedSkillId === null || splitConversationCommand(draft)?.command === selectedSkillId
}

export function resolveSkillSubmission(draft: string): SelectedConversationSkillId | null {
  const command = splitConversationCommand(draft)?.command
  const action = CONVERSATION_ACTIONS.find(({ id }) => id === command)?.id
  return action && action !== 'concept' ? action : null
}

// 文案 key 显式枚举：类型以 zh-CN 资源为基准，拼错在类型检查阶段暴露，
// 双语 key 集合一致性由 resources.test.ts 保证。
export type ConversationActionTextKey =
  | 'conversation:actionPicker.actions.sentence.name'
  | 'conversation:actionPicker.actions.sentence.description'
  | 'conversation:actionPicker.actions.tts.name'
  | 'conversation:actionPicker.actions.tts.description'
  | 'conversation:actionPicker.actions.vocabulary.name'
  | 'conversation:actionPicker.actions.vocabulary.description'
  | 'conversation:actionPicker.actions.synonym.name'
  | 'conversation:actionPicker.actions.synonym.description'
  | 'conversation:actionPicker.actions.phrase.name'
  | 'conversation:actionPicker.actions.phrase.description'
  | 'conversation:actionPicker.actions.explorePhrase.name'
  | 'conversation:actionPicker.actions.explorePhrase.description'
  | 'conversation:actionPicker.actions.exploreVocabulary.name'
  | 'conversation:actionPicker.actions.exploreVocabulary.description'
  | 'conversation:actionPicker.actions.concept.name'
  | 'conversation:actionPicker.actions.concept.description'

export interface ConversationActionMeta {
  // 稳定行动 ID：高亮身份与选择结果的协议字段，不随界面语言变化。
  readonly id: ConversationActionId
  // 稳定命令名（不含斜杠）：展示为 /command，并参与过滤。
  readonly command: string
  readonly nameKey: ConversationActionTextKey
  readonly descriptionKey: ConversationActionTextKey
}

// 行动目录仅收录有真实引擎实现的命令（concept 专用提示词，vocabulary/phrase/synonym
// 类型化技能）；数组顺序即展示顺序，过滤结果沿用该顺序。
export const CONVERSATION_ACTIONS: readonly ConversationActionMeta[] = [
  {
    id: 'concept',
    command: 'concept',
    nameKey: 'conversation:actionPicker.actions.concept.name',
    descriptionKey: 'conversation:actionPicker.actions.concept.description'
  },
  {
    id: 'vocabulary',
    command: 'vocabulary',
    nameKey: 'conversation:actionPicker.actions.vocabulary.name',
    descriptionKey: 'conversation:actionPicker.actions.vocabulary.description'
  },
  {
    id: 'phrase',
    command: 'phrase',
    nameKey: 'conversation:actionPicker.actions.phrase.name',
    descriptionKey: 'conversation:actionPicker.actions.phrase.description'
  },
  {
    id: 'explore-phrase',
    command: 'explore-phrase',
    nameKey: 'conversation:actionPicker.actions.explorePhrase.name',
    descriptionKey: 'conversation:actionPicker.actions.explorePhrase.description'
  },
  {
    id: 'explore-vocabulary',
    command: 'explore-vocabulary',
    nameKey: 'conversation:actionPicker.actions.exploreVocabulary.name',
    descriptionKey: 'conversation:actionPicker.actions.exploreVocabulary.description'
  },
  {
    id: 'synonym',
    command: 'synonym',
    nameKey: 'conversation:actionPicker.actions.synonym.name',
    descriptionKey: 'conversation:actionPicker.actions.synonym.description'
  },
  {
    id: 'sentence',
    command: 'sentence',
    nameKey: 'conversation:actionPicker.actions.sentence.name',
    descriptionKey: 'conversation:actionPicker.actions.sentence.description'
  },
  {
    id: 'tts',
    command: 'tts',
    nameKey: 'conversation:actionPicker.actions.tts.name',
    descriptionKey: 'conversation:actionPicker.actions.tts.description'
  }
]

// 仅半角 `/` 作为首字符触发；不做 trim，前导空格与全角斜杠都不算。
// 返回值为 `/` 之后的查询词，不符合前缀时为 undefined。
export function parseSlashTrigger(draft: string): string | undefined {
  if (!draft.startsWith('/')) return undefined
  const command = splitConversationCommand(draft)?.command
  if (CONVERSATION_ACTIONS.some(({ id }) => id === command)) return undefined
  return draft.slice(1)
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
