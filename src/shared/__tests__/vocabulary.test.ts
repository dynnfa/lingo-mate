import { describe, expect, it } from 'vitest'
import {
  addVocabularyBatchInputSchema,
  deleteVocabularyInputSchema,
  deleteVocabularyResultSchema,
  listVocabularyInputSchema,
  listVocabularyResultSchema,
  vocabularyEntrySchema,
  vocabularyPageSchema,
  VOCABULARY_CHANNELS
} from '../vocabulary'

describe('vocabulary schemas', () => {
  it('accepts entries with complete content', () => {
    expect(
      vocabularyEntrySchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        term: 'apple',
        phonetic: ['/ˈæpəl/'],
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
        phonetic: ['/ˈæpəl/'],
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

const ENTRY = {
  id: '11111111-1111-4111-8111-111111111111',
  term: 'apple',
  phonetic: ['/ˈæpəl/'],
  meaning: '苹果，一种水果。',
  concept: '苹果果实。',
  exampleSentences: ['I ate an apple after lunch.'],
  createdAt: '2026-09-07T00:00:00.000Z'
}

describe('vocabulary management protocol', () => {
  it('defines stable domain-named channels', () => {
    expect(VOCABULARY_CHANNELS).toEqual({ list: 'vocabulary:list', delete: 'vocabulary:delete' })
  })

  it('accepts a complete page and omits nextCursor when absent', () => {
    expect(
      vocabularyPageSchema.parse({
        entries: [ENTRY],
        nextCursor: { createdAt: ENTRY.createdAt, id: ENTRY.id }
      })
    ).toEqual({
      entries: [ENTRY],
      nextCursor: { createdAt: ENTRY.createdAt, id: ENTRY.id }
    })
    expect(vocabularyPageSchema.parse({ entries: [] })).toEqual({ entries: [] })
    expect(vocabularyPageSchema.safeParse({ entries: [], nextCursor: null }).success).toBe(false)
  })

  it('validates list results as an ok/error discriminated union', () => {
    expect(listVocabularyResultSchema.parse({ status: 'ok', entries: [ENTRY] })).toEqual({
      status: 'ok',
      entries: [ENTRY]
    })
    expect(
      listVocabularyResultSchema.parse({
        status: 'error',
        error: { code: 'STORAGE_FAILED' }
      })
    ).toEqual({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    for (const value of [
      { status: 'ok', entries: [{ ...ENTRY, term: 1 }] },
      { status: 'ok' },
      { status: 'error', error: { code: 'MODEL_ERROR' } },
      { status: 'error', error: { code: 'STORAGE_FAILED', sql: 'select' } },
      { status: 'pending' }
    ]) {
      expect(listVocabularyResultSchema.safeParse(value).success).toBe(false)
    }
  })

  it('rejects delete inputs outside a bare record UUID', () => {
    expect(deleteVocabularyInputSchema.parse({ id: ENTRY.id })).toEqual({ id: ENTRY.id })
    for (const value of [
      { id: 'not-a-uuid' },
      { term: 'apple' },
      { id: ENTRY.id, term: 'apple' },
      {}
    ]) {
      expect(deleteVocabularyInputSchema.safeParse(value).success).toBe(false)
    }
  })

  it('validates delete results and keeps missing targets idempotent', () => {
    expect(
      deleteVocabularyResultSchema.parse({ status: 'ok', id: ENTRY.id, deleted: true })
    ).toEqual({ status: 'ok', id: ENTRY.id, deleted: true })
    expect(
      deleteVocabularyResultSchema.parse({ status: 'ok', id: ENTRY.id, deleted: false })
    ).toEqual({ status: 'ok', id: ENTRY.id, deleted: false })
    expect(
      deleteVocabularyResultSchema.parse({ status: 'error', error: { code: 'INVALID_INPUT' } })
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    for (const value of [
      { status: 'ok', id: ENTRY.id },
      { status: 'ok', id: 'not-a-uuid', deleted: true },
      { status: 'ok', id: ENTRY.id, deleted: 'yes', term: 'apple' },
      { status: 'error', error: { code: 'CANCELLED' } }
    ]) {
      expect(deleteVocabularyResultSchema.safeParse(value).success).toBe(false)
    }
  })
})
