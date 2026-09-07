import { randomUUID } from 'node:crypto'
import type { VocabularyEntry } from '../../../../shared/vocabulary'
import { normalizeLookupKey } from '../parse-vocabulary-input'
import type { VocabularyInsertCommand, VocabularyInsertContent } from '../vocabulary-insert'
import { buildVocabularyInsertCommand } from '../vocabulary-insert'
import type { VocabularyRepository } from '../vocabulary-repository'
import type { VocabularyAnalysisResult } from '../vocabulary-analyzer'

export function content(
  term = 'apple',
  overrides: Partial<VocabularyInsertContent> = {}
): VocabularyInsertContent {
  return {
    term,
    phonetic: '/ˈæpəl/',
    meaning: '苹果，一种水果。',
    concept: '通常指作为食物的苹果果实，可用于日常饮食和购物场景。',
    exampleSentences: ['I ate an apple after lunch.'],
    ...overrides
  }
}
export const insertResult = (term = 'apple'): VocabularyAnalysisResult => ({
  status: 'insert',
  content: content(term),
  modelId: 'fixture-model',
  promptVersion: 'vocabulary-sql-v1'
})
export function insertCommand(
  term = 'apple',
  system: Partial<{ id: string; modelId: string; promptVersion: string; createdAt: string }> = {}
): VocabularyInsertCommand {
  return buildVocabularyInsertCommand(content(term), {
    id: system.id ?? randomUUID(),
    modelId: system.modelId ?? 'fixture-model',
    promptVersion: system.promptVersion ?? 'vocabulary-sql-v1',
    createdAt: system.createdAt ?? new Date().toISOString()
  })
}
function toEntry(parameters: VocabularyInsertCommand['parameters']): VocabularyEntry {
  return {
    id: parameters.id,
    term: parameters.term,
    phonetic: parameters.phonetic,
    meaning: parameters.meaning,
    concept: parameters.concept,
    exampleSentences: JSON.parse(parameters.example_sentences) as string[],
    createdAt: parameters.created_at
  }
}
export function memoryRepository(): VocabularyRepository & { commands: VocabularyInsertCommand[] } {
  const commands: VocabularyInsertCommand[] = []
  const save = (
    values: VocabularyInsertCommand[]
  ): Array<{ id: string; status: 'saved' | 'existing' }> =>
    values.map((value) => {
      const key = normalizeLookupKey(value.parameters.term)
      const existing = commands.find(
        (command) => normalizeLookupKey(command.parameters.term) === key
      )
      if (existing) return { id: existing.parameters.id, status: 'existing' as const }
      commands.push(value)
      return { id: value.parameters.id, status: 'saved' as const }
    })
  return {
    commands,
    find: (lookupKey) => {
      const command = commands.find(
        (item) => normalizeLookupKey(item.parameters.term) === lookupKey
      )
      return command ? toEntry(command.parameters) : undefined
    },
    findExisting: (lookupKeys) => {
      const found = new Map<string, VocabularyEntry>()
      for (const key of lookupKeys) {
        const entry = commands.find((item) => normalizeLookupKey(item.parameters.term) === key)
        if (entry) found.set(key, toEntry(entry.parameters))
      }
      return found
    },
    saveBatch: save,
    saveBatchWithResult: (_executionId, values, finalize) => finalize(save(values)),
    list: () => ({ entries: commands.map((command) => toEntry(command.parameters)) })
  }
}
