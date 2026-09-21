import { describe, expect, it } from 'vitest'
import {
  EXPLORE_VOCABULARY_HISTORY_BATCH_LIMIT,
  EXPLORE_VOCABULARY_ITEM_COUNT,
  exploreVocabularyHistoryBatchSchema,
  exploreVocabularyHistoryDocumentSchema,
  exploreVocabularyReportSchema,
  isExploreVocabularyReport
} from '../explore-vocabulary'
import { runConversationSkillInputSchema } from '../conversation'

const EXECUTION_ID = '550e8400-e29b-41d4-a716-446655440000'
const SESSION_ID = '9e9da1a9-b768-4c2d-8271-63f73fdb8018'
const USER_MESSAGE_ID = '87282ea8-174f-419a-9c28-19f72bd421c0'

function makeItem(term: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    term,
    normalizedTerm: term,
    explanation: '可靠的；值得信赖的。',
    example: `We need a ${term} internet connection for the meeting.`,
    ...overrides
  }
}

function makeBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const terms = Array.from(
    { length: EXPLORE_VOCABULARY_ITEM_COUNT },
    (_unused, index) => `word${index}`
  )
  return {
    executionId: EXECUTION_ID,
    sessionId: SESSION_ID,
    userMessageId: USER_MESSAGE_ID,
    committedAt: '2026-09-21T10:30:00.000Z',
    wordLanguage: 'en',
    explanationLanguage: 'zh-CN',
    items: terms.map((term) => makeItem(term)),
    ...overrides
  }
}

describe('explore vocabulary protocol schemas', () => {
  it('accepts a batch with exactly ten items', () => {
    expect(exploreVocabularyHistoryBatchSchema.parse(makeBatch())).toBeTruthy()
  })

  it('rejects batches without exactly ten items', () => {
    expect(exploreVocabularyHistoryBatchSchema.safeParse(makeBatch({ items: [] })).success).toBe(
      false
    )
    expect(
      exploreVocabularyHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: Array.from({ length: 11 }, (_unused, index) => makeItem(`word${index}`))
      }).success
    ).toBe(false)
  })

  it('rejects duplicate normalized terms inside one batch', () => {
    const items = Array.from({ length: EXPLORE_VOCABULARY_ITEM_COUNT }, () => makeItem('reliable'))
    expect(exploreVocabularyHistoryBatchSchema.safeParse(makeBatch({ items })).success).toBe(false)
  })

  it('rejects empty, whitespace-only, multiline or overlong fields', () => {
    expect(
      exploreVocabularyHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: [
          makeItem('word0', { term: '' }),
          ...Array.from({ length: 9 }, (_unused, index) => makeItem(`word${index}`))
        ]
      }).success
    ).toBe(false)
    expect(
      exploreVocabularyHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: [
          makeItem('word0', { explanation: '  \n  ' }),
          ...Array.from({ length: 9 }, (_unused, index) => makeItem(`word${index}`))
        ]
      }).success
    ).toBe(false)
    expect(
      exploreVocabularyHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: [
          makeItem('word0', { example: 'line one\nline two' }),
          ...Array.from({ length: 9 }, (_unused, index) => makeItem(`word${index}`))
        ]
      }).success
    ).toBe(false)
    expect(
      exploreVocabularyHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: [
          makeItem('word0', { explanation: 'x'.repeat(1001) }),
          ...Array.from({ length: 9 }, (_unused, index) => makeItem(`word${index}`))
        ]
      }).success
    ).toBe(false)
    expect(
      exploreVocabularyHistoryBatchSchema.safeParse({
        ...makeBatch(),
        items: [
          makeItem('x'.repeat(201)),
          ...Array.from({ length: 9 }, (_unused, index) => makeItem(`word${index}`))
        ]
      }).success
    ).toBe(false)
  })

  it('rejects unexpected fields, invalid languages and non-uuid identities', () => {
    expect(exploreVocabularyHistoryBatchSchema.safeParse(makeBatch({ extra: 1 })).success).toBe(
      false
    )
    expect(
      exploreVocabularyHistoryBatchSchema.safeParse(makeBatch({ wordLanguage: 'fr' })).success
    ).toBe(false)
    expect(
      exploreVocabularyHistoryBatchSchema.safeParse(makeBatch({ explanationLanguage: 'ja' }))
        .success
    ).toBe(false)
    expect(
      exploreVocabularyHistoryBatchSchema.safeParse(makeBatch({ executionId: 'x' })).success
    ).toBe(false)
  })

  it('caps the history document at seven batches and locks schemaVersion to 1', () => {
    const batches = Array.from(
      { length: EXPLORE_VOCABULARY_HISTORY_BATCH_LIMIT },
      (_unused, index) =>
        makeBatch({
          executionId: `550e8400-e29b-41d4-a716-44665544000${index}`,
          items: Array.from({ length: EXPLORE_VOCABULARY_ITEM_COUNT }, (_unused2, item) =>
            makeItem(`b${index}word${item}`)
          )
        })
    )
    expect(exploreVocabularyHistoryDocumentSchema.parse({ schemaVersion: 1, batches })).toBeTruthy()
    expect(
      exploreVocabularyHistoryDocumentSchema.safeParse({
        schemaVersion: 1,
        batches: [...batches, makeBatch({ executionId: '550e8400-e29b-41d4-a716-446655440009' })]
      }).success
    ).toBe(false)
    expect(
      exploreVocabularyHistoryDocumentSchema.safeParse({ schemaVersion: 2, batches }).success
    ).toBe(false)
  })

  it('discriminates the report by the stable skillId field', () => {
    const report = { skillId: 'explore-vocabulary', ...makeBatch() }
    expect(isExploreVocabularyReport(report)).toBe(true)
    expect(exploreVocabularyReportSchema.parse(report)).toBeTruthy()
    expect(isExploreVocabularyReport(makeBatch())).toBe(false)
    expect(isExploreVocabularyReport({ skillId: 'explore-phrase', ...makeBatch() })).toBe(false)
  })
})

describe('explore vocabulary skill input protocol', () => {
  it('accepts the no-argument skill input and rejects extra fields', () => {
    const input = {
      requestId: EXECUTION_ID,
      sessionId: SESSION_ID,
      skillId: 'explore-vocabulary',
      arguments: { wordLanguage: 'en' }
    }
    expect(runConversationSkillInputSchema.parse(input)).toEqual(input)
    expect(
      runConversationSkillInputSchema.safeParse({
        ...input,
        arguments: { wordLanguage: 'en', text: 'hi' }
      }).success
    ).toBe(false)
  })
})
