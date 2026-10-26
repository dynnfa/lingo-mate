// `/` 行动选择器的展示元数据与纯函数：只描述稳定身份与文案 key，
// 不包含 Prompt 或业务执行逻辑；技能选择（或完整命令输入）会转换为
// 类型化会话 skill 提交，不作为普通聊天发送。

export type ConversationActionId =
  'tts' | 'concept' | 'vocabulary' | 'phrase' | 'explore-phrase' | 'explore-vocabulary' | 'synonym'
export type SelectedConversationSkillId =
  'tts' | 'vocabulary' | 'phrase' | 'explore-phrase' | 'explore-vocabulary' | 'synonym'

export const VOCABULARY_COMMAND_PREFIX = '/vocabulary'
export const PHRASE_COMMAND_PREFIX = '/phrase'
export const EXPLORE_PHRASE_COMMAND_PREFIX = '/explore-phrase'
export const EXPLORE_VOCABULARY_COMMAND_PREFIX = '/explore-vocabulary'

// 各技能命令（含斜杠）的前缀与完整命令模式：选择器建立的技能据此校验草稿，
// 支持直接输入的技能据此判定提交。命令元数据只在此处维护。
const SKILL_COMMANDS: Record<SelectedConversationSkillId, { prefix: string; pattern: RegExp }> = {
  tts: { prefix: '/tts', pattern: /^\/tts\s/u },
  synonym: { prefix: '/synonym', pattern: /^\/synonym\s/u },
  'explore-phrase': {
    prefix: EXPLORE_PHRASE_COMMAND_PREFIX,
    pattern: /^\/explore-phrase\s/u
  },
  'explore-vocabulary': {
    prefix: EXPLORE_VOCABULARY_COMMAND_PREFIX,
    pattern: /^\/explore-vocabulary\s/u
  },
  phrase: { prefix: PHRASE_COMMAND_PREFIX, pattern: /^\/phrase\s/u },
  vocabulary: { prefix: VOCABULARY_COMMAND_PREFIX, pattern: /^\/vocabulary\s/u }
}

// 支持直接输入完整命令提交的技能；vocabulary 仍需从选择器选择。
const TYPED_SKILL_IDS = [
  'tts',
  'synonym',
  'phrase',
  'explore-phrase',
  'explore-vocabulary'
] as const

// /explore-phrase 与 /explore-vocabulary 是无参数命令：仅允许命令本身加末尾
// 空白；带任何额外参数的输入都不再是合法命令（由 composer 提示输入无效）。
export function isExplorePhraseCommand(draft: string): boolean {
  return /^\/explore-phrase\s*$/u.test(draft)
}

export function isExploreVocabularyCommand(draft: string): boolean {
  return /^\/explore-vocabulary\s*$/u.test(draft)
}

export type SkillDraftResult =
  { status: 'ok'; text: string } | { status: 'empty' } | { status: 'invalid-prefix' }

export function isSelectedSkillDraft(
  draft: string,
  selectedSkillId: SelectedConversationSkillId | null
): boolean {
  if (selectedSkillId === null) return true
  const { prefix, pattern } = SKILL_COMMANDS[selectedSkillId]
  return draft === prefix || pattern.test(draft)
}

export function extractSkillDraft(
  draft: string,
  selectedSkillId: SelectedConversationSkillId | null
): SkillDraftResult {
  if (selectedSkillId === null) return { status: 'invalid-prefix' }
  if (draft === SKILL_COMMANDS[selectedSkillId].prefix) return { status: 'empty' }
  const prefix = SKILL_COMMANDS[selectedSkillId].pattern.exec(draft)?.[0]
  if (!prefix) return { status: 'invalid-prefix' }
  // 短语参数支持多行：trim 只去掉首尾空白，行结构与行内空格原样保留。
  const body = draft.slice(prefix.length)
  const text = selectedSkillId === 'tts' ? body : body.trim()
  return text.trim() ? { status: 'ok', text } : { status: 'empty' }
}

// 提交时的技能判定：优先沿用选择器建立的技能；未选择时，完整输入的
// /phrase 与 /synonym 命令也按技能提交。
export function resolveSkillSubmission(
  draft: string,
  selectedSkillId: SelectedConversationSkillId | null
): SelectedConversationSkillId | null {
  if (selectedSkillId !== null && isSelectedSkillDraft(draft, selectedSkillId)) {
    return selectedSkillId
  }
  for (const skillId of TYPED_SKILL_IDS) {
    const { prefix, pattern } = SKILL_COMMANDS[skillId]
    if (draft === prefix || pattern.test(draft)) return skillId
  }
  return null
}

// 文案 key 显式枚举：类型以 zh-CN 资源为基准，拼错在类型检查阶段暴露，
// 双语 key 集合一致性由 resources.test.ts 保证。
export type ConversationActionTextKey =
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
    id: 'tts',
    command: 'tts',
    nameKey: 'conversation:actionPicker.actions.tts.name',
    descriptionKey: 'conversation:actionPicker.actions.tts.description'
  }
]

// 仅半角 `/` 作为首字符触发；不做 trim，前导空格与全角斜杠都不算。
// 返回值为 `/` 之后的查询词，不符合前缀时为 undefined。
export function parseSlashTrigger(draft: string): string | undefined {
  // 完整 concept 命令与可直输技能命令进入参数阶段后直接发送，不再作为选择器查询。
  if (/^\/concept\s/u.test(draft)) return undefined
  // 无参数命令输完即命令完整，同样直接进入提交阶段。
  if (isExplorePhraseCommand(draft)) return undefined
  if (isExploreVocabularyCommand(draft)) return undefined
  if (TYPED_SKILL_IDS.some((skillId) => SKILL_COMMANDS[skillId].pattern.test(draft)))
    return undefined
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
