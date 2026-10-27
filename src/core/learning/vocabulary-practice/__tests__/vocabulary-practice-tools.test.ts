import { describe, expect, it } from 'vitest'
import {
  markTextRedSchema,
  VocabularyPracticeToolExecutor,
  vocabularyPracticeTools
} from '../vocabulary-practice-tools'
import { VocabularyPracticeError } from '../parse-vocabulary-practice-input'

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'
const FOREIGN = '33333333-3333-4333-8333-333333333333'

function executor(): VocabularyPracticeToolExecutor {
  return new VocabularyPracticeToolExecutor(new Set([UUID, UUID2]), new AbortController().signal)
}

const item = (
  entryId: string,
  reason = '释义与单词含义不匹配'
): { entryId: string; field: 'meaning'; reason: string } => ({
  entryId,
  field: 'meaning' as const,
  reason
})

describe('mark_text_red tool', () => {
  it('exposes exactly one function tool with a strict JSON schema', () => {
    const tools = vocabularyPracticeTools()
    expect(tools).toHaveLength(1)
    const tool = tools[0]
    expect(tool.type).toBe('function')
    if (tool.type !== 'function') throw new Error('expected a function tool')
    expect(tool.function.name).toBe('mark_text_red')
    // field 只允许 meaning 枚举
    const schema = JSON.stringify(tool.function.parameters)
    expect(schema).toContain('meaning')
  })

  it('marks snapshot entries and reports the accumulated count', () => {
    const tool = executor()
    const outcome = tool.execute('mark_text_red', { items: [item(UUID)] })
    expect(outcome).toEqual({ ok: true, result: { status: 'marked', markedCount: 1 } })
    const second = tool.execute('mark_text_red', { items: [item(UUID2, '拼写无关')] })
    expect(second).toEqual({ ok: true, result: { status: 'marked', markedCount: 2 } })
    expect(tool.marked).toEqual([item(UUID), item(UUID2, '拼写无关')])
  })

  it('is idempotent for repeated marks of the same field', () => {
    const tool = executor()
    tool.execute('mark_text_red', { items: [item(UUID, '第一次原因')] })
    const outcome = tool.execute('mark_text_red', { items: [item(UUID, '第二次原因')] })
    expect(outcome).toEqual({ ok: true, result: { status: 'marked', markedCount: 1 } })
    // 保留首次原因
    expect(tool.marked).toEqual([item(UUID, '第一次原因')])
  })

  it('rejects unknown tools and malformed arguments without executing', () => {
    const tool = executor()
    expect(tool.execute('delete_vocabulary', { items: [item(UUID)] })).toEqual({
      ok: false,
      error: 'UNKNOWN_TOOL'
    })
    expect(tool.execute('mark_text_red', {})).toEqual({ ok: false, error: 'INVALID_ARGUMENTS' })
    // 空数组、field 越界、原因缺失或超长都非法
    expect(tool.execute('mark_text_red', { items: [] })).toEqual({
      ok: false,
      error: 'INVALID_ARGUMENTS'
    })
    expect(
      tool.execute('mark_text_red', { items: [{ entryId: UUID, field: 'term', reason: 'x' }] })
    ).toEqual({ ok: false, error: 'INVALID_ARGUMENTS' })
    expect(
      tool.execute('mark_text_red', { items: [{ entryId: UUID, field: 'meaning', reason: '' }] })
    ).toEqual({ ok: false, error: 'INVALID_ARGUMENTS' })
    expect(
      tool.execute('mark_text_red', {
        items: [{ entryId: UUID, field: 'meaning', reason: 'x'.repeat(501) }]
      })
    ).toEqual({
      ok: false,
      error: 'INVALID_ARGUMENTS'
    })
    expect(tool.marked).toEqual([])
  })

  it('rejects entry ids outside the snapshot atomically', () => {
    const tool = executor()
    // 混入越界 ID 时整次调用不生效，已合法项也不落盘
    expect(tool.execute('mark_text_red', { items: [item(UUID), item(FOREIGN)] })).toEqual({
      ok: false,
      error: 'UNKNOWN_ENTRY_ID'
    })
    expect(tool.marked).toEqual([])
  })

  it('throws CANCELLED when the abort signal already fired', () => {
    const controller = new AbortController()
    const tool = new VocabularyPracticeToolExecutor(new Set([UUID]), controller.signal)
    controller.abort()
    expect(() => tool.execute('mark_text_red', { items: [item(UUID)] })).toThrow(
      VocabularyPracticeError
    )
  })

  it('bounds a single call to at most 50 items in the schema', () => {
    const items = Array.from({ length: 51 }, () => item(UUID))
    expect(markTextRedSchema.safeParse({ items }).success).toBe(false)
    expect(markTextRedSchema.safeParse({ items: items.slice(0, 50) }).success).toBe(true)
  })
})
