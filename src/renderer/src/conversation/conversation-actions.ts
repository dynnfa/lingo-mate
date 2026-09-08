// `/` 行动选择器的展示元数据与纯函数：只描述稳定身份与文案 key，
// 不包含 Prompt 或业务执行逻辑；技能选择（或完整命令输入）会转换为
// 类型化会话 skill 提交，不作为普通聊天发送。

export type ConversationActionId =
  'translate' | 'polish' | 'practice' | 'concept' | 'vocabulary' | 'phrase'
export type SelectedConversationSkillId = 'vocabulary' | 'phrase'

export const VOCABULARY_COMMAND_PREFIX = '/vocabulary'
export const PHRASE_COMMAND_PREFIX = '/phrase'

// 命令名（含斜杠）到技能的映射：直接输入完整命令时据此提交。
// 首版仅 phrase 支持直接输入；vocabulary 仍需从选择器选择。
const TYPED_SKILL_COMMANDS: ReadonlyArray<{
  skillId: SelectedConversationSkillId
  prefix: string
  pattern: RegExp
}> = [{ skillId: 'phrase', prefix: PHRASE_COMMAND_PREFIX, pattern: /^\/phrase\s/u }]

const skillCommandPattern = (skillId: SelectedConversationSkillId): RegExp =>
  skillId === 'phrase' ? /^\/phrase\s/u : /^\/vocabulary\s/u
const skillCommandPrefix = (skillId: SelectedConversationSkillId): string =>
  skillId === 'phrase' ? PHRASE_COMMAND_PREFIX : VOCABULARY_COMMAND_PREFIX

export type SkillDraftResult =
  { status: 'ok'; text: string } | { status: 'empty' } | { status: 'invalid-prefix' }

export function isSelectedSkillDraft(
  draft: string,
  selectedSkillId: SelectedConversationSkillId | null
): boolean {
  if (selectedSkillId === null) return true
  return (
    draft === skillCommandPrefix(selectedSkillId) ||
    skillCommandPattern(selectedSkillId).test(draft)
  )
}

export function extractSkillDraft(
  draft: string,
  selectedSkillId: SelectedConversationSkillId | null
): SkillDraftResult {
  if (selectedSkillId === null) return { status: 'invalid-prefix' }
  const prefix = skillCommandPattern(selectedSkillId).exec(draft)?.[0]
  if (!prefix) return { status: 'invalid-prefix' }
  // 短语参数支持多行：trim 只去掉首尾空白，行结构与行内空格原样保留。
  const text = draft.slice(prefix.length).trim()
  return text ? { status: 'ok', text } : { status: 'empty' }
}

// 提交时的技能判定：优先沿用选择器建立的技能；未选择时，完整输入的
// /phrase 命令也按技能提交。
export function resolveSkillSubmission(
  draft: string,
  selectedSkillId: SelectedConversationSkillId | null
): SelectedConversationSkillId | null {
  if (selectedSkillId !== null && isSelectedSkillDraft(draft, selectedSkillId)) {
    return selectedSkillId
  }
  for (const { prefix, pattern, skillId } of TYPED_SKILL_COMMANDS) {
    if (draft === prefix || pattern.test(draft)) return skillId
  }
  return null
}

// 文案 key 显式枚举：类型以 zh-CN 资源为基准，拼错在类型检查阶段暴露，
// 双语 key 集合一致性由 resources.test.ts 保证。
export type ConversationActionTextKey =
  | 'conversation:actionPicker.actions.vocabulary.name'
  | 'conversation:actionPicker.actions.vocabulary.description'
  | 'conversation:actionPicker.actions.phrase.name'
  | 'conversation:actionPicker.actions.phrase.description'
  | 'conversation:actionPicker.actions.translate.name'
  | 'conversation:actionPicker.actions.translate.description'
  | 'conversation:actionPicker.actions.polish.name'
  | 'conversation:actionPicker.actions.polish.description'
  | 'conversation:actionPicker.actions.practice.name'
  | 'conversation:actionPicker.actions.practice.description'
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
  }
]

// 仅半角 `/` 作为首字符触发；不做 trim，前导空格与全角斜杠都不算。
// 返回值为 `/` 之后的查询词，不符合前缀时为 undefined。
export function parseSlashTrigger(draft: string): string | undefined {
  // 完整 concept / phrase 命令进入参数阶段后直接发送，不再作为选择器查询。
  if (/^\/concept\s/u.test(draft)) return undefined
  if (/^\/phrase\s/u.test(draft)) return undefined
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
