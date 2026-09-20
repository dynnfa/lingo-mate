import { describe, expect, it } from 'vitest'
import {
  EXPLORE_PHRASE_HISTORY_BATCH_LIMIT,
  EXPLORE_PHRASE_ITEM_COUNT,
  explorePhraseHistoryBatchSchema,
  explorePhraseHistoryDocumentSchema,
  explorePhraseReportSchema,
  isExplorePhraseReport
} from '../explore-phrase'

const EXECUTION_ID = '550e8400-e29b-41d4-a716-446655440000'
const SESSION_ID = '9e9da1a9-b768-4c2d-8271-63f73fdb8018'
const USER_MESSAGE_ID = '87282ea8-174f-419a-9c28-19f72bd421c0'

function makeItem(
  phrase: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    phrase,
    normalizedPhrase: phrase,
    explanation: '因此；结果是。用于引出前述情况造成的结果。',
    example: `It rained heavily, and ${phrase}, the match was cancelled.`,
    ...overrides
  }
}

function makeBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const phrases = Array.from(
    { length: EXPLORE_PHRASE_ITEM_COUNT },
    (_unused, index) => `phrase ${index}`
  )
  return {
    executionId: EXECUTION_ID,
    sessionId: SESSION_ID,
    userMessageId: USER_MESSAGE_ID,
    committedAt: '2026-09-20T10:30:00.000Z',
    wordLanguage: 'en',
    explanationLanguage: 'zh-CN',
    items: phrases.map((phrase) => makeItem(phrase)),
    ...overrides
  }
}

describe('explore phrase protocol schemas', () => {
  it('accepts a batch with exactly ten items', () => {
    expect(explorePhraseHistoryBatchSchema.parse(makeBatch())).toBeTruthy()
  })

  it('rejects batches without exactly ten items', () => {
    expect(explorePhraseHistoryBatchSchema.safeParse(makeBatch({ items: [] })).success).toBe(false)
    expect(
      explorePhraseHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: Array.from({ length: 11 }, (_unused, index) => makeItem(`phrase ${index}`))
      }).success
    ).toBe(false)
  })

  it('rejects duplicate normalized phrases inside one batch', () => {
    const items = Array.from({ length: EXPLORE_PHRASE_ITEM_COUNT }, () => makeItem('as a result'))

    expect(explorePhraseHistoryBatchSchema.safeParse(makeBatch({ items })).success).toBe(false)
  })

  it('rejects empty, whitespace-only, multiline or overlong fields', () => {
    expect(
      explorePhraseHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: [
          makeItem('as a result', { phrase: '' }),
          ...Array.from({ length: 9 }, (_unused, index) => makeItem(`phrase ${index}`))
        ]
      }).success
    ).toBe(false)
    expect(
      explorePhraseHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: [
          makeItem('as a result', { explanation: '  \n  ' }),
          ...Array.from({ length: 9 }, (_unused, index) => makeItem(`phrase ${index}`))
        ]
      }).success
    ).toBe(false)
    expect(
      explorePhraseHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: [
          makeItem('as a result', { example: 'line one\nline two' }),
          ...Array.from({ length: 9 }, (_unused, index) => makeItem(`phrase ${index}`))
        ]
      }).success
    ).toBe(false)
    expect(
      explorePhraseHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: [
          makeItem('as a result', { explanation: 'x'.repeat(1001) }),
          ...Array.from({ length: 9 }, (_unused, index) => makeItem(`phrase ${index}`))
        ]
      }).success
    ).toBe(false)
    expect(
      explorePhraseHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: [
          makeItem('x'.repeat(201)),
          ...Array.from({ length: 9 }, (_unused, index) => makeItem(`phrase ${index}`))
        ]
      }).success
    ).toBe(false)
  })

  it('rejects unexpected fields, invalid languages and non-uuid identities', () => {
    expect(explorePhraseHistoryBatchSchema.safeParse(makeBatch({ extra: 1 })).success).toBe(false)
    expect(
      explorePhraseHistoryBatchSchema.safeParse(makeBatch({ wordLanguage: 'fr' })).success
    ).toBe(false)
    expect(
      explorePhraseHistoryBatchSchema.safeParse(makeBatch({ explanationLanguage: 'ja' })).success
    ).toBe(false)
    expect(explorePhraseHistoryBatchSchema.safeParse(makeBatch({ executionId: 'x' })).success).toBe(
      false
    )
  })

  it('caps the history document at seven batches and locks schemaVersion to 1', () => {
    const batches = Array.from({ length: EXPLORE_PHRASE_HISTORY_BATCH_LIMIT }, (_unused, index) =>
      makeBatch({
        executionId: `550e8400-e29b-41d4-a716-44665544000${index}`,
        items: Array.from({ length: EXPLORE_PHRASE_ITEM_COUNT }, (_unused2, item) =>
          makeItem(`batch ${index} phrase ${item}`)
        )
      })
    )
    expect(explorePhraseHistoryDocumentSchema.parse({ schemaVersion: 1, batches })).toBeTruthy()
    expect(
      explorePhraseHistoryDocumentSchema.safeParse({
        schemaVersion: 1,
        batches: [...batches, makeBatch({ executionId: '550e8400-e29b-41d4-a716-446655440009' })]
      }).success
    ).toBe(false)
    expect(
      explorePhraseHistoryDocumentSchema.safeParse({ schemaVersion: 2, batches }).success
    ).toBe(false)
  })

  it('discriminates the report by the stable skillId field', () => {
    const report = { skillId: 'explore-phrase', ...makeBatch() }
    expect(isExplorePhraseReport(report)).toBe(true)
    expect(explorePhraseReportSchema.parse(report)).toBeTruthy()
    expect(isExplorePhraseReport(makeBatch())).toBe(false)
    expect(isExplorePhraseReport({ skillId: 'phrase', ...makeBatch() })).toBe(false)
  })
})
