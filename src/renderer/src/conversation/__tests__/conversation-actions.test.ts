import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_ACTIONS,
  filterConversationActions,
  parseSlashTrigger,
  resolveSkillSubmission,
  type ConversationActionMeta
} from '../conversation-actions'

// 模拟界面语言为 zh-CN 时本地化名称的解析；组件内由 i18n t 提供。
const zhNames: Record<string, string> = {
  concept: '概念讲解',
  vocabulary: '收藏词汇',
  phrase: '收录短语',
  'explore-phrase': '探索短语',
  'explore-vocabulary': '探索词汇',
  synonym: '近义词分组'
}

const resolveZhName = (action: ConversationActionMeta): string => zhNames[action.id] ?? ''

describe('parseSlashTrigger', () => {
  it('stops querying when concept has a command separator', () => {
    expect(parseSlashTrigger('/concept')).toBeUndefined()
    expect(parseSlashTrigger('/concept ')).toBeUndefined()
    expect(parseSlashTrigger('/concept pursue')).toBeUndefined()
    expect(parseSlashTrigger('/concept\tbank')).toBeUndefined()
    expect(parseSlashTrigger('/conceptual drift')).toBe('conceptual drift')
  })

  it('stops querying when phrase has a command separator', () => {
    expect(parseSlashTrigger('/phrase')).toBeUndefined()
    expect(parseSlashTrigger('/phrase ')).toBeUndefined()
    expect(parseSlashTrigger('/phrase look forward to')).toBeUndefined()
    expect(parseSlashTrigger('/phrases book')).toBe('phrases book')
  })

  it('treats a leading half-width slash as the trigger and returns the query', () => {
    expect(parseSlashTrigger('/')).toBe('')
    expect(parseSlashTrigger('/tr')).toBe('tr')
    expect(parseSlashTrigger('/note 你好')).toBe('note 你好')
  })

  it('does not trigger for non-leading slash, leading space or full-width slash', () => {
    expect(parseSlashTrigger('hello /')).toBeUndefined()
    expect(parseSlashTrigger(' /')).toBeUndefined()
    expect(parseSlashTrigger('／')).toBeUndefined()
    expect(parseSlashTrigger('／tr')).toBeUndefined()
    expect(parseSlashTrigger('')).toBeUndefined()
    expect(parseSlashTrigger('practice / now')).toBeUndefined()
  })
})

it.each([
  'tts',
  'vocabulary',
  'phrase',
  'sentence',
  'synonym',
  'explore-phrase',
  'explore-vocabulary'
])('shows parameter hints for exact /%s commands', (command) => {
  expect(resolveSkillSubmission(`/${command}`)).toBe(command)
  expect(resolveSkillSubmission(`\t/${command}\u3000body`)).toBe(command)
  expect(resolveSkillSubmission(`/${command}-extra body`)).toBeNull()
  expect(resolveSkillSubmission(`note /${command} body`)).toBeNull()
  expect(parseSlashTrigger(`/${command} body`)).toBeUndefined()
})

describe('CONVERSATION_ACTIONS catalog', () => {
  it('keeps commands unique', () => {
    expect(new Set(CONVERSATION_ACTIONS.map((action) => action.command)).size).toBe(
      CONVERSATION_ACTIONS.length
    )
  })

  it('keeps every command free of the slash and whitespace', () => {
    for (const action of CONVERSATION_ACTIONS) {
      expect(action.command.startsWith('/')).toBe(false)
      expect(action.command.trim()).toBe(action.command)
    }
  })
})

describe('filterConversationActions', () => {
  it('returns the whole catalog in order for an empty query', () => {
    expect(filterConversationActions(CONVERSATION_ACTIONS, '', resolveZhName)).toEqual([
      ...CONVERSATION_ACTIONS
    ])
  })

  it('does not mutate the input catalog', () => {
    const before = [...CONVERSATION_ACTIONS]
    filterConversationActions(CONVERSATION_ACTIONS, 'phrase', resolveZhName)
    expect([...CONVERSATION_ACTIONS]).toEqual(before)
  })
})
