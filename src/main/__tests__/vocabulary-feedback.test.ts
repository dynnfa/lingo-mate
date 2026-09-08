import { describe, expect, it } from 'vitest'
import { createVocabularyFeedbackFormatter } from '../vocabulary-feedback'
import type { VocabularyBatch } from '../../shared/vocabulary'
import vocabularyEn from '../../shared/locales/en/vocabulary.json'
import vocabularyZhCN from '../../shared/locales/zh-CN/vocabulary.json'

const batch = (items: VocabularyBatch['items']): VocabularyBatch => {
  const counts = { total: items.length, saved: 0, existing: 0, duplicate: 0, failed: 0 }
  for (const item of items) counts[item.status]++
  const resolved = items.filter((item) => {
    const source = item.status === 'duplicate' ? items[item.sourceInputIndex] : item
    return source.status === 'saved' || source.status === 'existing'
  }).length
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    explanationLanguage: 'en',
    outcome: resolved === items.length ? 'completed' : resolved ? 'partial' : 'failed',
    items,
    counts
  }
}

describe('createVocabularyFeedbackFormatter', () => {
  it('reports committed facts in both locales with localized term lists', () => {
    const feedback = createVocabularyFeedbackFormatter()
    const result = batch([
      {
        inputIndex: 0,
        term: 'apple',
        status: 'saved',
        entryId: '11111111-1111-4111-8111-111111111111'
      },
      {
        inputIndex: 1,
        term: 'banana',
        status: 'saved',
        entryId: '22222222-2222-4222-8222-222222222222'
      },
      {
        inputIndex: 2,
        term: 'orange',
        status: 'existing',
        entryId: '33333333-3333-4333-8333-333333333333'
      },
      { inputIndex: 3, term: 'apple', status: 'duplicate', sourceInputIndex: 0 },
      { inputIndex: 4, term: 'bad', status: 'failed', code: 'UNRECOGNIZED' }
    ])
    expect(feedback(result, 'en')).toBe(
      'Processed 5 terms: 2 added (apple and banana); 1 already saved (orange); ' +
        '1 repeated in this input (apple); 1 failed (bad).'
    )
    expect(feedback(result, 'zh-CN')).toBe(
      '已处理 5 个词汇：新增 2 个（apple和banana）；已有 1 个（orange）；输入重复 1 个（apple）；失败 1 个（bad）。'
    )
  })
  it('omits empty groups and notes duplicates whose source failed', () => {
    const feedback = createVocabularyFeedbackFormatter()
    const result = batch([
      { inputIndex: 0, term: 'bad', status: 'failed', code: 'MODEL_ERROR' },
      { inputIndex: 1, term: 'bad', status: 'duplicate', sourceInputIndex: 0 }
    ])
    expect(feedback(result, 'en')).toBe(
      'Processed 2 terms: 1 repeated in this input (bad); 1 failed (bad).\n' +
        'Repeated items whose source word failed were not saved.'
    )
    expect(feedback(result, 'zh-CN')).toContain('未保存')
  })
  it.each([
    ['saved', '1 added (apple)', '新增 1 个（apple）'],
    ['existing', '1 already saved (apple)', '已有 1 个（apple）'],
    ['failed', '1 failed (apple)', '失败 1 个（apple）']
  ] as const)('reports only the %s group when it is the only result', (status, en, zh) => {
    const feedback = createVocabularyFeedbackFormatter()
    const result = batch([
      status === 'failed'
        ? { inputIndex: 0, term: 'apple', status, code: 'MODEL_ERROR' }
        : {
            inputIndex: 0,
            term: 'apple',
            status,
            entryId: '11111111-1111-4111-8111-111111111111'
          }
    ])
    expect(feedback(result, 'en')).toBe(`Processed 1 terms: ${en}.`)
    expect(feedback(result, 'zh-CN')).toBe(`已处理 1 个词汇：${zh}。`)
  })
  it('keeps locale resource key sets and placeholders aligned', () => {
    const keys = (value: object): string[] =>
      Object.entries(value).flatMap(([key, nested]) =>
        typeof nested === 'object' && nested !== null
          ? keys(nested as object).map((child) => `${key}.${child}`)
          : [key]
      )
    expect(keys(vocabularyEn)).toEqual(keys(vocabularyZhCN))
    const placeholders = (value: object): string[] =>
      Object.values(value).flatMap((nested) =>
        typeof nested === 'string'
          ? [...nested.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort()
          : placeholders(nested as object)
      )
    expect(placeholders(vocabularyEn)).toEqual(placeholders(vocabularyZhCN))
  })
})
