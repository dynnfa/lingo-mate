import { describe, expect, it } from 'vitest'
import { ANALYSIS } from '../../core/learning/vocabulary/__tests__/fixtures'
import {
  addVocabularyBatchInputSchema,
  listVocabularyInputSchema,
  vocabularyAnalysisSchema
} from '../vocabulary'

describe('vocabulary schemas', () => {
  it('accepts linked senses sharing pronunciations', () => {
    const analysis = structuredClone(ANALYSIS)
    analysis.senses.push({ id: 's2', partOfSpeech: 'other', definition: 'A second meaning' })
    analysis.pronunciations[0].senseIds.push('s2')
    expect(vocabularyAnalysisSchema.safeParse(analysis).success).toBe(true)
  })
  it.each([
    { ...ANALYSIS, extra: true },
    { ...ANALYSIS, senses: [] },
    { ...ANALYSIS, pronunciations: [] },
    { ...ANALYSIS, senses: Array(6).fill(ANALYSIS.senses[0]) },
    { ...ANALYSIS, pronunciations: Array(7).fill(ANALYSIS.pronunciations[0]) },
    { ...ANALYSIS, senses: [ANALYSIS.senses[0], ANALYSIS.senses[0]] },
    ...['', 'x'.repeat(501)].map((definition) => ({
      ...ANALYSIS,
      senses: [{ ...ANALYSIS.senses[0], definition }]
    })),
    { ...ANALYSIS, senses: [{ ...ANALYSIS.senses[0], partOfSpeech: 'made-up' }] },
    ...['apple', '/ /', '/…/', '/?/', '/unknown/', '/123/', '/' + 'a'.repeat(200) + '/'].map(
      (ipa) => ({
        ...ANALYSIS,
        pronunciations: [{ ...ANALYSIS.pronunciations[0], ipa }]
      })
    ),
    ...[[], ['s2'], ['s1', 's1']].map((senseIds) => ({
      ...ANALYSIS,
      pronunciations: [{ ...ANALYSIS.pronunciations[0], senseIds }]
    })),
    ...['', 'a'.repeat(501)].map((guidance) => ({
      ...ANALYSIS,
      pronunciations: [{ ...ANALYSIS.pronunciations[0], guidance }]
    })),
    { ...ANALYSIS, pronunciations: [{ ...ANALYSIS.pronunciations[0], accent: 'fr' }] }
  ])('rejects malformed model analysis %#', (value) => {
    expect(vocabularyAnalysisSchema.safeParse(value).success).toBe(false)
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
