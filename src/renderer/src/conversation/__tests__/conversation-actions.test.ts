import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_ACTIONS,
  extractVocabularyDraft,
  filterConversationActions,
  isSelectedSkillDraft,
  parseSlashTrigger,
  type ConversationActionMeta
} from '../conversation-actions'

// 模拟界面语言为 zh-CN 时本地化名称的解析；组件内由 i18n t 提供。
const zhNames: Record<string, string> = {
  translate: '翻译',
  polish: '润色',
  practice: '口语练习',
  vocabulary: '收藏词汇'
}

const resolveZhName = (action: ConversationActionMeta): string => zhNames[action.id] ?? ''

describe('parseSlashTrigger', () => {
  it('treats a leading half-width slash as the trigger and returns the query', () => {
    expect(parseSlashTrigger('/')).toBe('')
    expect(parseSlashTrigger('/tr')).toBe('tr')
    expect(parseSlashTrigger('/translate 你好')).toBe('translate 你好')
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

describe('vocabulary command boundary', () => {
  it('extracts only text after the selected complete command prefix', () => {
    expect(extractVocabularyDraft('/vocabulary apple, banana', 'vocabulary')).toEqual({
      status: 'ok',
      text: 'apple, banana'
    })
    expect(extractVocabularyDraft('/vocabulary   ', 'vocabulary')).toEqual({ status: 'empty' })
    expect(extractVocabularyDraft('/vocabulary\tapple', 'vocabulary')).toEqual({
      status: 'ok',
      text: 'apple'
    })
  })

  it('does not activate pasted, embedded, or modified commands', () => {
    expect(extractVocabularyDraft('/vocabulary apple', null)).toEqual({
      status: 'invalid-prefix'
    })
    expect(extractVocabularyDraft('note /vocabulary apple', 'vocabulary')).toEqual({
      status: 'invalid-prefix'
    })
    expect(isSelectedSkillDraft('/vocab apple', 'vocabulary')).toBe(false)
    expect(isSelectedSkillDraft('/vocabulary apple', 'vocabulary')).toBe(true)
  })
})

describe('CONVERSATION_ACTIONS catalog', () => {
  it('lists stable unique ids and commands in display order', () => {
    expect(CONVERSATION_ACTIONS.map((action) => action.id)).toEqual([
      'translate',
      'polish',
      'practice',
      'vocabulary'
    ])
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

  it('matches command names case-insensitively', () => {
    expect(filterConversationActions(CONVERSATION_ACTIONS, 'TRANSLATE', resolveZhName)).toEqual([
      CONVERSATION_ACTIONS[0]
    ])
    expect(filterConversationActions(CONVERSATION_ACTIONS, 'Pra', resolveZhName)).toEqual([
      CONVERSATION_ACTIONS[2]
    ])
  })

  it('matches localized names and keeps catalog order for multiple hits', () => {
    expect(filterConversationActions(CONVERSATION_ACTIONS, '润', resolveZhName)).toEqual([
      CONVERSATION_ACTIONS[1]
    ])
    // “t” 命中 translate 与 practice 两个命令名，顺序沿用目录
    expect(filterConversationActions(CONVERSATION_ACTIONS, 't', resolveZhName)).toEqual([
      CONVERSATION_ACTIONS[0],
      CONVERSATION_ACTIONS[2]
    ])
  })

  it('returns an empty list for queries that match nothing, including spaced queries', () => {
    expect(filterConversationActions(CONVERSATION_ACTIONS, 'xyz', resolveZhName)).toEqual([])
    expect(filterConversationActions(CONVERSATION_ACTIONS, 'translate me', resolveZhName)).toEqual(
      []
    )
    expect(filterConversationActions(CONVERSATION_ACTIONS, ' ', resolveZhName)).toEqual([])
  })

  it('does not mutate the input catalog', () => {
    const before = [...CONVERSATION_ACTIONS]
    filterConversationActions(CONVERSATION_ACTIONS, 'polish', resolveZhName)
    expect([...CONVERSATION_ACTIONS]).toEqual(before)
  })
})
