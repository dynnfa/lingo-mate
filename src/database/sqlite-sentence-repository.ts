import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  sentenceContentSchema,
  sentenceEntrySchema,
  sentenceReportSchema,
  listSentenceInputSchema,
  type SentenceContent,
  type SentenceEntry,
  type SentencePage,
  type SentenceReport,
  type ListSentenceInput
} from '../shared/sentence'
import type { SupportedLocale, TargetLanguage } from '../shared/preferences'
import {
  SentenceError,
  type SentenceRepository
} from '../core/learning/sentence/sentence-repository'
const columns =
  'id, source_text AS sourceText, translation, target_language AS targetLanguage, created_at AS createdAt'
export class SqliteSentenceRepository implements SentenceRepository {
  constructor(private readonly database: Database.Database) {}
  findExisting(sourceText: string, targetLanguage: TargetLanguage): SentenceEntry | undefined {
    return this.storage(() => {
      const row = this.database
        .prepare(`SELECT ${columns} FROM sentence WHERE target_language = ? AND source_text = ?`)
        .get(targetLanguage, sourceText)
      return row ? sentenceEntrySchema.parse(row) : undefined
    })
  }
  commit(
    executionId: string,
    requestId: string,
    language: SupportedLocale,
    raw: SentenceContent
  ): SentenceReport {
    return this.storage(() =>
      this.database
        .transaction(() => {
          const content = sentenceContentSchema.parse(raw)
          const candidate = { ...content, id: randomUUID(), createdAt: new Date().toISOString() }
          const result = this.database
            .prepare(
              `INSERT INTO sentence (id, source_text, translation, target_language, created_at)
        VALUES (@id, @sourceText, @translation, @targetLanguage, @createdAt)
        ON CONFLICT(target_language, source_text) DO NOTHING`
            )
            .run(candidate)
          const entry = this.findExisting(content.sourceText, content.targetLanguage)!
          const report = sentenceReportSchema.parse({
            skillId: 'sentence',
            requestId,
            explanationLanguage: language,
            status: result.changes ? 'saved' : 'existing',
            entry
          })
          const saved = this.database
            .prepare(
              `UPDATE conversation_skill_executions SET batch_json = ?, phase = 'summarizing', updated_at = ? WHERE id = ? AND skill_id = 'sentence' AND batch_json IS NULL`
            )
            .run(JSON.stringify(report), candidate.createdAt, executionId)
          if (saved.changes !== 1)
            throw new Error('Missing or already committed sentence execution')
          return report
        })
        .immediate()
    )
  }
  list(raw: ListSentenceInput): SentencePage {
    return this.storage(() => {
      const { limit, cursor } = listSentenceInputSchema.parse(raw)
      const rows = cursor
        ? this.database
            .prepare(
              `SELECT ${columns} FROM sentence WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
        : this.database
            .prepare(`SELECT ${columns} FROM sentence ORDER BY created_at DESC, id DESC LIMIT ?`)
            .all(limit + 1)
      const entries = rows.slice(0, limit).map((row) => sentenceEntrySchema.parse(row))
      const last = entries.at(-1)
      return {
        entries,
        ...(rows.length > limit && last
          ? { nextCursor: { createdAt: last.createdAt, id: last.id } }
          : {})
      }
    })
  }
  delete(id: string): boolean {
    return this.storage(
      () => this.database.prepare('DELETE FROM sentence WHERE id = ?').run(id).changes === 1
    )
  }
  private storage<T>(operation: () => T): T {
    try {
      return operation()
    } catch (cause) {
      throw new SentenceError('STORAGE_FAILED', { cause })
    }
  }
}
