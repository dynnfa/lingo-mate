import type Database from 'better-sqlite3'
import { z } from 'zod'
import {
  vocabularyEntrySchema,
  vocabularyBatchSchema,
  listVocabularyInputSchema,
  type VocabularyEntry,
  type ListVocabularyInput,
  type VocabularyBatch
} from '../shared/vocabulary'
import type {
  StoredVocabulary,
  VocabularyRepository,
  VocabularyPage
} from '../core/learning/vocabulary/vocabulary-repository'
import { VocabularyError } from '../core/learning/vocabulary/parse-vocabulary-input'

const storedSchema = vocabularyEntrySchema.extend({
  lookupKey: z.string().min(1).max(100),
  analysisSchemaVersion: z.literal(1),
  modelId: z.string().min(1).max(200),
  promptVersion: z.literal('vocabulary-v1'),
  updatedAt: z.iso.datetime()
})
const rowSchema = z.object({
  id: z.string(),
  term: z.string(),
  lookup_key: z.string(),
  word_language: z.string(),
  explanation_language: z.string(),
  analysis_json: z.string(),
  analysis_schema_version: z.number(),
  analysis_source: z.string(),
  model_id: z.string(),
  prompt_version: z.string(),
  created_at: z.string(),
  updated_at: z.string()
})
function fromRow(raw: unknown): VocabularyEntry {
  const row = rowSchema.parse(raw)
  const stored = storedSchema.parse({
    id: row.id,
    term: row.term,
    lookupKey: row.lookup_key,
    wordLanguage: row.word_language,
    explanationLanguage: row.explanation_language,
    analysis: JSON.parse(row.analysis_json) as unknown,
    analysisSchemaVersion: row.analysis_schema_version,
    analysisSource: row.analysis_source,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
  return vocabularyEntrySchema.parse({
    id: stored.id,
    term: stored.term,
    wordLanguage: stored.wordLanguage,
    explanationLanguage: stored.explanationLanguage,
    analysis: stored.analysis,
    analysisSource: stored.analysisSource,
    createdAt: stored.createdAt
  })
}
export class SqliteVocabularyRepository implements VocabularyRepository {
  constructor(private readonly database: Database.Database) {}
  find(wordLanguage: 'en', lookupKey: string): VocabularyEntry | undefined {
    return this.withStorage(() => {
      const row: unknown = this.database
        .prepare('SELECT * FROM vocabulary WHERE word_language = ? AND lookup_key = ?')
        .get(wordLanguage, lookupKey)
      return row ? fromRow(row) : undefined
    })
  }
  saveBatch(entries: StoredVocabulary[]): Array<{ id: string; status: 'saved' | 'existing' }> {
    return this.withStorage(() =>
      this.database.transaction(() => this.saveEntries(entries)).immediate()
    )
  }
  saveBatchWithResult(
    executionId: string,
    entries: StoredVocabulary[],
    finalize: (saved: Array<{ id: string; status: 'saved' | 'existing' }>) => VocabularyBatch
  ): VocabularyBatch {
    return this.withStorage(() =>
      this.database
        .transaction(() => {
          const saved = this.saveEntries(entries)
          const batch = vocabularyBatchSchema.parse(finalize(saved))
          const updated = this.database
            .prepare(
              `UPDATE conversation_skill_executions
               SET batch_json = ?, phase = 'summarizing', updated_at = ?
               WHERE id = ? AND batch_json IS NULL`
            )
            .run(JSON.stringify(batch), new Date().toISOString(), executionId)
          if (updated.changes !== 1) throw new Error('Missing or already committed skill execution')
          return batch
        })
        .immediate()
    )
  }
  list(raw: ListVocabularyInput): VocabularyPage {
    return this.withStorage(() => {
      const { limit, cursor } = listVocabularyInputSchema.parse(raw)
      const rows = cursor
        ? this.database
            .prepare(
              'SELECT * FROM vocabulary WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?'
            )
            .all(cursor.createdAt, cursor.id, limit + 1)
        : this.database
            .prepare('SELECT * FROM vocabulary ORDER BY created_at DESC, id DESC LIMIT ?')
            .all(limit + 1)
      const entries = rows.slice(0, limit).map(fromRow)
      const last = entries.at(-1)
      return {
        entries,
        ...(rows.length > limit && last
          ? { nextCursor: { createdAt: last.createdAt, id: last.id } }
          : {})
      }
    })
  }
  private withStorage<T>(operation: () => T): T {
    try {
      return operation()
    } catch (cause) {
      throw new VocabularyError('STORAGE_FAILED', { cause })
    }
  }

  private saveEntries(
    entries: StoredVocabulary[]
  ): Array<{ id: string; status: 'saved' | 'existing' }> {
    return entries.map((raw) => {
      const entry = storedSchema.parse(raw)
      const result = this.database
        .prepare(
          `INSERT INTO vocabulary
          (id, term, lookup_key, word_language, explanation_language, analysis_json, analysis_schema_version, analysis_source, model_id, prompt_version, created_at, updated_at)
          VALUES (@id, @term, @lookupKey, @wordLanguage, @explanationLanguage, @analysisJson, @analysisSchemaVersion, @analysisSource, @modelId, @promptVersion, @createdAt, @updatedAt)
          ON CONFLICT(word_language, lookup_key) DO NOTHING`
        )
        .run({ ...entry, analysisJson: JSON.stringify(entry.analysis) })
      if (result.changes) return { id: entry.id, status: 'saved' as const }
      const row = this.database
        .prepare('SELECT id FROM vocabulary WHERE word_language = ? AND lookup_key = ?')
        .get(entry.wordLanguage, entry.lookupKey) as { id: string } | undefined
      if (!row) throw new Error('Missing conflicting entry')
      return { id: row.id, status: 'existing' as const }
    })
  }
}
