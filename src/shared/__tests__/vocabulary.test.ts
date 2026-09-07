import { describe, expect, it } from 'vitest'
import {
  addVocabularyBatchInputSchema,
  listVocabularyInputSchema,
  vocabularyEntrySchema
} from '../vocabulary'

describe('vocabulary schemas', () => {
  it('accepts entries with complete content', () => {
    expect(
      vocabularyEntrySchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        term: 'apple',
        phonetic: '/ˈæpəl/',
        meaning: '苹果，一种水果。',
        concept: '通常指作为食物的苹果果实。',
        exampleSentences: ['I ate an apple after lunch.'],
        createdAt: '2026-09-07T00:00:00.000Z'
      }).success
    ).toBe(true)
  })
  it('allows NULL content fields for historical v5 rows', () => {
    expect(
      vocabularyEntrySchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        term: 'apple',
        phonetic: null,
        meaning: null,
        concept: null,
        exampleSentences: null,
        createdAt: '2026-09-07T00:00:00.000Z'
      }).success
    ).toBe(true)
  })
  it.each([
    { phonetic: '' },
    { meaning: '' },
    { concept: 'x'.repeat(2001) },
    { phonetic: 'x'.repeat(201) },
    { exampleSentences: [] },
    { exampleSentences: [''] },
    { exampleSentences: Array(4).fill('A sentence.') },
    { exampleSentences: ['x'.repeat(501)] },
    { exampleSentences: 'not an array' },
    { term: '' },
    { extra: true }
  ])('rejects malformed entries %#', (overrides) => {
    expect(
      vocabularyEntrySchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        term: 'apple',
        phonetic: '/ˈæpəl/',
        meaning: '苹果',
        concept: '苹果果实',
        exampleSentences: ['A sentence.'],
        createdAt: '2026-09-07T00:00:00.000Z',
        ...overrides
      }).success
    ).toBe(false)
  })
  it('validates narrow IPC input and keyset cursors', () => {
    expect(
      addVocabularyBatchInputSchema.safeParse({
        requestId: 'no',
        text: 'apple',
        wordLanguage: 'en'
      }).success
    ).toBe(false)
    expect(listVocabularyInputSchema.parse({})).toEqual({ limit: 50 })
    for (const value of [
      { limit: 101 },
      { limit: 0 },
      { cursor: { id: 'invalid', createdAt: 'today' } },
      { sql: 'select' }
    ]) {
      expect(listVocabularyInputSchema.safeParse(value).success).toBe(false)
    }
  })
})

describe('batch response integrity', () => {
  it('rejects contradictory counts, duplicate references and success outcomes', async () => {
    const { vocabularyBatchSchema } = await import('../vocabulary')
    const valid = {
      requestId: '11111111-1111-4111-8111-111111111111',
      explanationLanguage: 'en',
      outcome: 'failed',
      counts: { total: 2, saved: 0, existing: 0, duplicate: 1, failed: 1 },
      items: [
        { inputIndex: 0, term: 'bad', status: 'failed', code: 'UNRECOGNIZED' },
        { inputIndex: 1, term: 'bad', status: 'duplicate', sourceInputIndex: 0 }
      ]
    }
    expect(vocabularyBatchSchema.safeParse(valid).success).toBe(true)
    expect(
      vocabularyBatchSchema.safeParse({
        ...valid,
        items: [{ ...valid.items[0], code: 'TOOL_CALL_NOT_SUPPORTED' }, valid.items[1]]
      }).success
    ).toBe(false)
    expect(vocabularyBatchSchema.safeParse({ ...valid, outcome: 'completed' }).success).toBe(false)
    expect(
      vocabularyBatchSchema.safeParse({ ...valid, counts: { ...valid.counts, saved: 1 } }).success
    ).toBe(false)
    expect(
      vocabularyBatchSchema.safeParse({
        ...valid,
        items: [valid.items[0], { ...valid.items[1], sourceInputIndex: 1 }]
      }).success
    ).toBe(false)
  })
})
