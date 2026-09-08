import { describe, expect, it } from 'vitest'
import { createPhraseFeedbackFormatter } from '../phrase-feedback'
import type { PhraseBatch } from '../../shared/phrase'
import phraseEn from '../../shared/locales/en/phrase.json'
import phraseZhCN from '../../shared/locales/zh-CN/phrase.json'

const batch = (items: PhraseBatch['items']): PhraseBatch => {
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

describe('createPhraseFeedbackFormatter', () => {
  it('reports committed facts in both locales with localized phrase lists', () => {
    const feedback = createPhraseFeedbackFormatter()
    const result = batch([
      {
        inputIndex: 0,
        input: 'look forward to',
        phrase: 'look forward to',
        status: 'saved'
      },
      { inputIndex: 1, input: 'break even', phrase: 'break even', status: 'saved' },
      { inputIndex: 2, input: 'piece of cake', phrase: 'piece of cake', status: 'existing' },
      {
        inputIndex: 3,
        input: 'look forward to',
        phrase: 'look forward to',
        status: 'duplicate',
        sourceInputIndex: 0
      },
      {
        inputIndex: 4,
        input: 'zzz qqq',
        phrase: 'zzz qqq',
        status: 'failed',
        code: 'UNRECOGNIZED'
      },
      {
        inputIndex: 5,
        input: 'aaa bbb',
        phrase: 'aaa bbb',
        status: 'failed',
        code: 'MODEL_ERROR'
      }
    ])
    expect(feedback(result, 'en')).toBe(
      'Processed 6 phrases: 2 added (look forward to and break even); ' +
        '1 already saved (piece of cake); 1 repeated in this input (look forward to); ' +
        '1 not recognizable as English phrases (zzz qqq); 1 failed (aaa bbb).'
    )
    expect(feedback(result, 'zh-CN')).toBe(
      '已处理 6 个短语：新增 2 个（look forward to和break even）；' +
        '已有 1 个（piece of cake）；输入重复 1 个（look forward to）；' +
        '1 个无法识别为英语短语（zzz qqq）；1 个失败（aaa bbb）。'
    )
  })
  it('omits empty groups and notes duplicates whose source failed', () => {
    const feedback = createPhraseFeedbackFormatter()
    const result = batch([
      { inputIndex: 0, input: 'bad', phrase: 'bad', status: 'failed', code: 'MODEL_ERROR' },
      {
        inputIndex: 1,
        input: 'bad',
        phrase: 'bad',
        status: 'duplicate',
        sourceInputIndex: 0
      }
    ])
    expect(feedback(result, 'en')).toBe(
      'Processed 2 phrases: 1 repeated in this input (bad); 1 failed (bad).\n' +
        'Repeated items whose source phrase failed were not saved.'
    )
    expect(feedback(result, 'zh-CN')).toContain('未保存')
  })
  it('shows unrecognized items as their own group without a failed line', () => {
    const feedback = createPhraseFeedbackFormatter()
    const result = batch([
      { inputIndex: 0, input: 'zzz qqq', phrase: 'zzz qqq', status: 'failed', code: 'UNRECOGNIZED' }
    ])
    expect(feedback(result, 'en')).toBe(
      'Processed 1 phrases: 1 not recognizable as English phrases (zzz qqq).'
    )
    expect(feedback(result, 'zh-CN')).toBe('已处理 1 个短语：1 个无法识别为英语短语（zzz qqq）。')
  })
  it('keeps locale resource key sets and placeholders aligned', () => {
    const keys = (value: object): string[] =>
      Object.entries(value).flatMap(([key, nested]) =>
        typeof nested === 'object' && nested !== null
          ? keys(nested as object).map((child) => `${key}.${child}`)
          : [key]
      )
    expect(keys(phraseEn)).toEqual(keys(phraseZhCN))
    const placeholders = (value: object): string[] =>
      Object.values(value).flatMap((nested) =>
        typeof nested === 'string'
          ? [...nested.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort()
          : placeholders(nested as object)
      )
    expect(placeholders(phraseEn)).toEqual(placeholders(phraseZhCN))
  })
})
