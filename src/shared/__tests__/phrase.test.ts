import { describe, expect, it } from 'vitest'
import { addPhraseBatchInputSchema, isPhraseBatch, phraseBatchSchema } from '../phrase'
import { isVocabularyBatch } from '../vocabulary'

// 以合法单条新增为基准构造批次。
interface DraftBatch {
  [key: string]: unknown
  items: Array<Record<string, unknown>>
}
function batch(overrides: Record<string, unknown> = {}): DraftBatch {
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    outcome: 'completed',
    explanationLanguage: 'zh-CN',
    items: [
      {
        inputIndex: 0,
        input: 'look forward to',
        phrase: 'look forward to',
        status: 'saved'
      }
    ],
    counts: { total: 1, saved: 1, existing: 0, duplicate: 0, failed: 0 },
    ...overrides
  }
}

describe('phrase shared protocol', () => {
  it('accepts a consistent batch report and the add input limits', () => {
    expect(phraseBatchSchema.parse(batch())).toBeTruthy()
    expect(
      addPhraseBatchInputSchema.parse({
        requestId: '11111111-1111-4111-8111-111111111111',
        text: 'look forward to\nbreak even',
        wordLanguage: 'en'
      })
    ).toBeTruthy()
    expect(
      addPhraseBatchInputSchema.safeParse({
        requestId: '11111111-1111-4111-8111-111111111111',
        text: '',
        wordLanguage: 'en'
      }).success
    ).toBe(false)
    expect(
      addPhraseBatchInputSchema.safeParse({
        requestId: '11111111-1111-4111-8111-111111111111',
        text: 'x'.repeat(4001),
        wordLanguage: 'en'
      }).success
    ).toBe(false)
  })
  it.each([
    [
      'mismatched counts',
      batch({ counts: { total: 1, saved: 0, existing: 1, duplicate: 0, failed: 0 } })
    ],
    ['non-sequential inputIndex', batch({ items: [{ ...batch().items[0], inputIndex: 1 }] })],
    [
      'duplicate pointing forward',
      batch({
        items: [
          batch().items[0],
          { inputIndex: 1, input: 'x', phrase: 'x', status: 'duplicate', sourceInputIndex: 2 }
        ],
        counts: { total: 2, saved: 1, existing: 0, duplicate: 1, failed: 0 }
      })
    ],
    ['outcome not derived from items', batch({ outcome: 'failed' })],
    ['cancelled with saved items', batch({ outcome: 'cancelled' })],
    ['over-long phrase', batch({ items: [{ ...batch().items[0], phrase: 'x'.repeat(201) }] })],
    ['empty original input', batch({ items: [{ ...batch().items[0], input: '' }] })],
    ['unknown extra field', batch({ entryId: '11111111-1111-4111-8111-111111111111' })]
  ])('rejects inconsistent reports: %s', (_name, value) => {
    expect(phraseBatchSchema.safeParse(value).success).toBe(false)
  })
  it('accepts a cancelled report that saved nothing', () => {
    const cancelled = batch({
      outcome: 'cancelled',
      items: [
        {
          inputIndex: 0,
          input: 'look forward to',
          phrase: 'look forward to',
          status: 'failed',
          code: 'CANCELLED'
        }
      ],
      counts: { total: 1, saved: 0, existing: 0, duplicate: 0, failed: 1 }
    })
    expect(phraseBatchSchema.parse(cancelled).outcome).toBe('cancelled')
  })
  it('discriminates phrase reports from vocabulary reports', () => {
    expect(isPhraseBatch(batch())).toBe(true)
    expect(isPhraseBatch({})).toBe(false)
    // vocabulary 报告（term/entryId 字段）不会被 phrase 守卫接受
    const vocabularyReport = {
      requestId: '11111111-1111-4111-8111-111111111111',
      outcome: 'completed',
      explanationLanguage: 'en',
      items: [
        {
          inputIndex: 0,
          term: 'apple',
          status: 'saved',
          entryId: '22222222-2222-4222-8222-222222222222'
        }
      ],
      counts: { total: 1, saved: 1, existing: 0, duplicate: 0, failed: 0 }
    }
    expect(isVocabularyBatch(vocabularyReport)).toBe(true)
    expect(isPhraseBatch(vocabularyReport)).toBe(false)
    expect(isVocabularyBatch(batch())).toBe(false)
  })
})
