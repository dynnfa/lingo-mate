import type {
  VocabularyEntry,
  VocabularyCursor,
  ListVocabularyInput
} from '../../../shared/vocabulary'

export interface StoredVocabulary extends VocabularyEntry {
  lookupKey: string
  analysisSchemaVersion: 1
  modelId: string
  promptVersion: 'vocabulary-v1'
  updatedAt: string
}
export interface VocabularyPage {
  entries: VocabularyEntry[]
  nextCursor?: VocabularyCursor
}
export interface VocabularyRepository {
  find(wordLanguage: 'en', lookupKey: string): VocabularyEntry | undefined
  // Synchronous short transaction. No cancellation or async work may interleave with commit.
  saveBatch(entries: StoredVocabulary[]): Array<{ id: string; status: 'saved' | 'existing' }>
  list(input: ListVocabularyInput): VocabularyPage
}
