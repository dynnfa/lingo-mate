import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_ACTIONS,
  extractSkillDraft,
  filterConversationActions,
  isExplorePhraseCommand,
  isSelectedSkillDraft,
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
  synonym: '近义词分组'
}

const resolveZhName = (action: ConversationActionMeta): string => zhNames[action.id] ?? ''

describe('parseSlashTrigger', () => {
  it('stops querying when concept has a command separator', () => {
    expect(parseSlashTrigger('/concept')).toBe('concept')
    expect(parseSlashTrigger('/concept ')).toBeUndefined()
    expect(parseSlashTrigger('/concept pursue')).toBeUndefined()
    expect(parseSlashTrigger('/concept\tbank')).toBeUndefined()
    expect(parseSlashTrigger('/conceptual drift')).toBe('conceptual drift')
  })

  it('stops querying when phrase has a command separator', () => {
    expect(parseSlashTrigger('/phrase')).toBe('phrase')
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

describe('skill command boundary', () => {
  it('extracts only text after the selected complete command prefix', () => {
    expect(extractSkillDraft('/vocabulary apple, banana', 'vocabulary')).toEqual({
      status: 'ok',
      text: 'apple, banana'
    })
    expect(extractSkillDraft('/vocabulary   ', 'vocabulary')).toEqual({ status: 'empty' })
    expect(extractSkillDraft('/vocabulary\tapple', 'vocabulary')).toEqual({
      status: 'ok',
      text: 'apple'
    })
  })

  it('keeps multiline phrase arguments intact without splitting inner spaces or commas', () => {
    expect(extractSkillDraft('/phrase look forward to\nif anything, at all\n', 'phrase')).toEqual({
      status: 'ok',
      text: 'look forward to\nif anything, at all'
    })
    expect(extractSkillDraft('/phrase   ', 'phrase')).toEqual({ status: 'empty' })
    expect(extractSkillDraft('/phrase\tlook', 'phrase')).toEqual({ status: 'ok', text: 'look' })
  })

  it('does not activate pasted, embedded, or modified commands', () => {
    expect(extractSkillDraft('/vocabulary apple', null)).toEqual({
      status: 'invalid-prefix'
    })
    expect(extractSkillDraft('note /vocabulary apple', 'vocabulary')).toEqual({
      status: 'invalid-prefix'
    })
    expect(extractSkillDraft('note /phrase apple', 'phrase')).toEqual({
      status: 'invalid-prefix'
    })
    expect(isSelectedSkillDraft('/vocab apple', 'vocabulary')).toBe(false)
    expect(isSelectedSkillDraft('/vocabulary apple', 'vocabulary')).toBe(true)
    expect(isSelectedSkillDraft('/phrase apple', 'phrase')).toBe(true)
    expect(isSelectedSkillDraft('/vocabulary apple', 'phrase')).toBe(false)
    expect(isSelectedSkillDraft('plain text', null)).toBe(true)
  })

  it('resolves directly typed phrase commands without picker selection', () => {
    expect(resolveSkillSubmission('/phrase look forward to', null)).toBe('phrase')
    expect(resolveSkillSubmission('/phrase ', null)).toBe('phrase')
    expect(resolveSkillSubmission('/phrase', null)).toBe('phrase')
    // vocabulary 未选择时不因直接输入而激活：沿用既有选择器路径。
    expect(resolveSkillSubmission('/vocabulary apple', null)).toBeNull()
    expect(resolveSkillSubmission('/vocabulary apple', 'vocabulary')).toBe('vocabulary')
    expect(resolveSkillSubmission('/phrase anything', 'vocabulary')).toBe('phrase')
    expect(resolveSkillSubmission('hello', null)).toBeNull()
  })
})

describe('CONVERSATION_ACTIONS catalog', () => {
  it('lists stable unique ids and commands in display order', () => {
    expect(CONVERSATION_ACTIONS.map((action) => action.id)).toEqual([
      'concept',
      'vocabulary',
      'phrase',
      'explore-phrase',
      'synonym'
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

describe('explore-phrase command boundary', () => {
  it('recognizes the exact command and trailing whitespace only', () => {
    expect(isExplorePhraseCommand('/explore-phrase')).toBe(true)
    expect(isExplorePhraseCommand('/explore-phrase ')).toBe(true)
    expect(isExplorePhraseCommand('/explore-phrase  \t ')).toBe(true)
  })

  it('rejects extra arguments, prefixes of other commands and plain text', () => {
    expect(isExplorePhraseCommand('/explore-phrase foo')).toBe(false)
    expect(isExplorePhraseCommand('/explore-phrasefoo')).toBe(false)
    expect(isExplorePhraseCommand('/explore-phras')).toBe(false)
    expect(isExplorePhraseCommand('/phrase')).toBe(false)
    expect(isExplorePhraseCommand('explore-phrase')).toBe(false)
    expect(isExplorePhraseCommand('')).toBe(false)
  })

  it('resolves the typed command with and without a trailing separator', () => {
    expect(resolveSkillSubmission('/explore-phrase', null)).toBe('explore-phrase')
    expect(resolveSkillSubmission('/explore-phrase ', null)).toBe('explore-phrase')
    expect(resolveSkillSubmission('/explore-phrase foo', null)).toBe('explore-phrase')
    expect(resolveSkillSubmission('/explore-phras', null)).toBeNull()
  })

  it('keeps the picker closed once the command is complete or has arguments', () => {
    expect(parseSlashTrigger('/explore-phrase')).toBeUndefined()
    expect(parseSlashTrigger('/explore-phrase ')).toBeUndefined()
    expect(parseSlashTrigger('/explore-phrase foo')).toBeUndefined()
    // 未输完的命令仍作为查询过滤候选
    expect(parseSlashTrigger('/explore-ph')).toBe('explore-ph')
  })

  it('keeps the picker selection while the draft stays the bare command', () => {
    expect(isSelectedSkillDraft('/explore-phrase', 'explore-phrase')).toBe(true)
    expect(isSelectedSkillDraft('/explore-phrase ', 'explore-phrase')).toBe(true)
    expect(isSelectedSkillDraft('/explore-phrase foo', 'explore-phrase')).toBe(true)
    expect(isSelectedSkillDraft('/phrase x', 'explore-phrase')).toBe(false)
  })
})

describe('filterConversationActions', () => {
  it('returns the whole catalog in order for an empty query', () => {
    expect(filterConversationActions(CONVERSATION_ACTIONS, '', resolveZhName)).toEqual([
      ...CONVERSATION_ACTIONS
    ])
  })

  it('matches command names case-insensitively', () => {
    expect(filterConversationActions(CONVERSATION_ACTIONS, 'CONCEPT', resolveZhName)).toEqual([
      CONVERSATION_ACTIONS[0]
    ])
    expect(filterConversationActions(CONVERSATION_ACTIONS, 'PHR', resolveZhName)).toEqual([
      CONVERSATION_ACTIONS[2],
      CONVERSATION_ACTIONS[3]
    ])
  })

  it('matches localized names and keeps catalog order for multiple hits', () => {
    expect(filterConversationActions(CONVERSATION_ACTIONS, '概', resolveZhName)).toEqual([
      CONVERSATION_ACTIONS[0]
    ])
    expect(filterConversationActions(CONVERSATION_ACTIONS, '近义', resolveZhName)).toEqual([
      CONVERSATION_ACTIONS[4]
    ])
    // “收” 命中收藏词汇与收录短语的本地化名称，顺序沿用目录
    expect(filterConversationActions(CONVERSATION_ACTIONS, '收', resolveZhName)).toEqual([
      CONVERSATION_ACTIONS[1],
      CONVERSATION_ACTIONS[2]
    ])
    // “探索” 命中探索短语的本地化名称
    expect(filterConversationActions(CONVERSATION_ACTIONS, '探索', resolveZhName)).toEqual([
      CONVERSATION_ACTIONS[3]
    ])
    // “o” 命中 concept、vocabulary、explore-phrase 与 synonym 四个命令名，顺序沿用目录
    expect(filterConversationActions(CONVERSATION_ACTIONS, 'o', resolveZhName)).toEqual([
      CONVERSATION_ACTIONS[0],
      CONVERSATION_ACTIONS[1],
      CONVERSATION_ACTIONS[3],
      CONVERSATION_ACTIONS[4]
    ])
  })

  it('returns an empty list for queries that match nothing, including spaced queries', () => {
    expect(filterConversationActions(CONVERSATION_ACTIONS, 'xyz', resolveZhName)).toEqual([])
    // 已移除的命令不再命中
    expect(filterConversationActions(CONVERSATION_ACTIONS, 'translate', resolveZhName)).toEqual([])
    expect(filterConversationActions(CONVERSATION_ACTIONS, 'concept me', resolveZhName)).toEqual([])
    expect(filterConversationActions(CONVERSATION_ACTIONS, ' ', resolveZhName)).toEqual([])
  })

  it('does not mutate the input catalog', () => {
    const before = [...CONVERSATION_ACTIONS]
    filterConversationActions(CONVERSATION_ACTIONS, 'phrase', resolveZhName)
    expect([...CONVERSATION_ACTIONS]).toEqual(before)
  })
})
