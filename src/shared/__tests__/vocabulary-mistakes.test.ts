import { describe, expect, it } from 'vitest'
import {
  listVocabularyMistakeHistoryInputSchema,
  listVocabularyMistakeHistoryResultSchema,
  listVocabularyMistakesInputSchema,
  listVocabularyMistakesResultSchema
} from '../vocabulary-mistakes'

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'
const STAMP = '2026-09-20T00:00:00.000Z'

const LIST_ITEM = {
  entryId: UUID,
  term: 'apple',
  lastSubmittedMeaning: '一种水果',
  totalMistakes: 2,
  lastErrorAt: STAMP
}

const HISTORY_ITEM = { id: UUID2, submittedMeaning: '一种水果', createdAt: STAMP }

describe('vocabulary mistakes protocol', () => {
  it('bounds the aggregate list input to a valid limit and cursor', () => {
    expect(listVocabularyMistakesInputSchema.safeParse({}).success).toBe(true)
    expect(listVocabularyMistakesInputSchema.parse({}).limit).toBe(50)
    for (const limit of [0, -1, 101, 1.5, '10', NaN]) {
      expect(listVocabularyMistakesInputSchema.safeParse({ limit }).success).toBe(false)
    }
    expect(
      listVocabularyMistakesInputSchema.safeParse({
        limit: 50,
        cursor: { lastErrorAt: STAMP, entryId: UUID }
      }).success
    ).toBe(true)
    // 游标必须是合法时间与 UUID，缺一不可
    for (const cursor of [
      { lastErrorAt: STAMP },
      { entryId: UUID },
      { lastErrorAt: 'not-a-date', entryId: UUID },
      { lastErrorAt: STAMP, entryId: 'not-a-uuid' }
    ]) {
      expect(listVocabularyMistakesInputSchema.safeParse({ cursor }).success).toBe(false)
    }
  })

  it('accepts a consistent aggregate list result and rejects malformed rows', () => {
    expect(
      listVocabularyMistakesResultSchema.safeParse({
        status: 'ok',
        entries: [LIST_ITEM],
        nextCursor: { lastErrorAt: STAMP, entryId: UUID2 }
      }).success
    ).toBe(true)
    // 末页缺省 nextCursor 合法
    expect(
      listVocabularyMistakesResultSchema.safeParse({ status: 'ok', entries: [LIST_ITEM] }).success
    ).toBe(true)
    // 累计次数至少为 1、释义与单词非空
    for (const overrides of [
      { totalMistakes: 0 },
      { totalMistakes: 1.5 },
      { lastSubmittedMeaning: '' },
      { lastSubmittedMeaning: '  ' },
      { lastSubmittedMeaning: 'x'.repeat(2001) },
      { term: '' },
      { entryId: 'not-a-uuid' },
      { lastErrorAt: 'not-a-date' }
    ]) {
      expect(
        listVocabularyMistakesResultSchema.safeParse({
          status: 'ok',
          entries: [{ ...LIST_ITEM, ...overrides }]
        }).success
      ).toBe(false)
    }
    expect(
      listVocabularyMistakesResultSchema.safeParse({
        status: 'error',
        error: { code: 'STORAGE_FAILED' }
      }).success
    ).toBe(true)
    // 错题查询不携带练习会话类错误码
    expect(
      listVocabularyMistakesResultSchema.safeParse({
        status: 'error',
        error: { code: 'SESSION_NOT_FOUND' }
      }).success
    ).toBe(false)
  })

  it('requires a uuid entryId and a valid limit for history queries', () => {
    expect(listVocabularyMistakeHistoryInputSchema.safeParse({ entryId: UUID }).success).toBe(true)
    for (const input of [
      {},
      { entryId: 'not-a-uuid' },
      { entryId: UUID, limit: 0 },
      { entryId: UUID, limit: 101 },
      { entryId: UUID, cursor: { createdAt: STAMP } },
      { entryId: UUID, cursor: { id: UUID2, createdAt: 'not-a-date' } }
    ]) {
      expect(listVocabularyMistakeHistoryInputSchema.safeParse(input).success).toBe(false)
    }
    expect(
      listVocabularyMistakeHistoryInputSchema.safeParse({
        entryId: UUID,
        limit: 20,
        cursor: { createdAt: STAMP, id: UUID2 }
      }).success
    ).toBe(true)
  })

  it('validates history result items', () => {
    expect(
      listVocabularyMistakeHistoryResultSchema.safeParse({ status: 'ok', items: [HISTORY_ITEM] })
        .success
    ).toBe(true)
    expect(
      listVocabularyMistakeHistoryResultSchema.safeParse({
        status: 'ok',
        items: [HISTORY_ITEM],
        nextCursor: { createdAt: STAMP, id: UUID }
      }).success
    ).toBe(true)
    for (const overrides of [
      { id: 'not-a-uuid' },
      { submittedMeaning: ' ' },
      { submittedMeaning: 'x'.repeat(2001) },
      { createdAt: 'not-a-date' }
    ]) {
      expect(
        listVocabularyMistakeHistoryResultSchema.safeParse({
          status: 'ok',
          items: [{ ...HISTORY_ITEM, ...overrides }]
        }).success
      ).toBe(false)
    }
  })
})
