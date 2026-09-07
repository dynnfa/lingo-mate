import { randomUUID } from 'node:crypto'
import type { VocabularyAnalysis } from '../../../../shared/vocabulary'
import type { StoredVocabulary, VocabularyRepository } from '../vocabulary-repository'
import type { VocabularyAnalysisResult } from '../vocabulary-analyzer'

export const ANALYSIS: VocabularyAnalysis = {
  senses: [{ id: 's1', partOfSpeech: 'noun', definition: '苹果，一种水果。' }],
  pronunciations: [
    { accent: 'en-US', ipa: '/ˈæpəl/', guidance: '重音在第一音节。', senseIds: ['s1'] }
  ]
}
export const recognized = (): VocabularyAnalysisResult => ({
  status: 'recognized',
  analysis: structuredClone(ANALYSIS),
  modelId: 'fixture-model',
  promptVersion: 'vocabulary-v1'
})
export function stored(
  term = 'apple',
  overrides: Partial<StoredVocabulary> = {}
): StoredVocabulary {
  const createdAt = new Date().toISOString()
  return {
    id: randomUUID(),
    term,
    lookupKey: term,
    wordLanguage: 'en',
    explanationLanguage: 'zh-CN',
    analysis: structuredClone(ANALYSIS),
    analysisSource: 'llm',
    analysisSchemaVersion: 1,
    modelId: 'fixture-model',
    promptVersion: 'vocabulary-v1',
    createdAt,
    updatedAt: createdAt,
    ...overrides
  }
}
export function memoryRepository(): VocabularyRepository & { entries: StoredVocabulary[] } {
  const entries: StoredVocabulary[] = []
  return {
    entries,
    find: (language, key) =>
      entries.find((entry) => entry.wordLanguage === language && entry.lookupKey === key),
    saveBatch: (values) =>
      values.map((value) => {
        const existing = entries.find(
          (entry) =>
            entry.wordLanguage === value.wordLanguage && entry.lookupKey === value.lookupKey
        )
        if (existing) return { id: existing.id, status: 'existing' }
        entries.push(value)
        return { id: value.id, status: 'saved' }
      }),
    list: () => ({ entries })
  }
}
