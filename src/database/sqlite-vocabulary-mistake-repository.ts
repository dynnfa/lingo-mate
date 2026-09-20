import type Database from 'better-sqlite3'
import { z } from 'zod'
import {
  listVocabularyMistakeHistoryInputSchema,
  listVocabularyMistakesInputSchema,
  vocabularyMistakeHistoryItemSchema,
  vocabularyMistakeListItemSchema,
  type ListVocabularyMistakeHistoryInput,
  type ListVocabularyMistakesInput,
  type VocabularyMistakeHistoryItem,
  type VocabularyMistakeListItem
} from '../shared/vocabulary-mistakes'
import { VocabularyMistakesError } from '../core/learning/vocabulary-practice/parse-vocabulary-mistakes-input'
import {
  vocabularyMistakeRecordSchema,
  type VocabularyMistakeRecord,
  type VocabularyMistakeHistoryPage,
  type VocabularyMistakesPage
} from '../core/learning/vocabulary-practice/vocabulary-mistake-repository'
import type { VocabularyMistakeRepository } from '../core/learning/vocabulary-practice/vocabulary-mistake-repository'

// 聚合行 = 每个词条最新一条错题 + 该词条累计次数；子查询按
// (entry_id, created_at DESC, id DESC) 索引取最新记录并计数。
const AGGREGATE_SELECT = `
  SELECT m.entry_id, m.term, m.submitted_meaning, m.created_at,
         (SELECT COUNT(*) FROM vocabulary_practice_mistakes c WHERE c.entry_id = m.entry_id) AS total_mistakes
  FROM vocabulary_practice_mistakes m
  WHERE m.id = (
    SELECT l.id FROM vocabulary_practice_mistakes l
    WHERE l.entry_id = m.entry_id
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT 1
  )`

const listRowSchema = z.object({
  entry_id: z.string(),
  term: z.string(),
  submitted_meaning: z.string(),
  created_at: z.string(),
  total_mistakes: z.number()
})

const historyRowSchema = z.object({
  id: z.string(),
  submitted_meaning: z.string(),
  created_at: z.string()
})

export class SqliteVocabularyMistakeRepository implements VocabularyMistakeRepository {
  constructor(private readonly database: Database.Database) {}

  saveBatch(records: VocabularyMistakeRecord[]): void {
    if (!records.length) return
    this.withStorage(() => {
      const validated = records.map((raw) => vocabularyMistakeRecordSchema.parse(raw))
      this.database
        .transaction(() => {
          const insert = this.database.prepare(`
            INSERT INTO vocabulary_practice_mistakes
              (id, review_id, entry_id, term, submitted_meaning, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (review_id, entry_id) DO NOTHING
          `)
          for (const record of validated) {
            insert.run(
              record.id,
              record.reviewId,
              record.entryId,
              record.term,
              record.submittedMeaning,
              record.createdAt
            )
          }
        })
        .immediate()
    })
  }

  list(raw: ListVocabularyMistakesInput): VocabularyMistakesPage {
    return this.withStorage(() => {
      const { limit, cursor } = listVocabularyMistakesInputSchema.parse(raw)
      const rows: unknown[] = cursor
        ? this.database
            .prepare(
              `${AGGREGATE_SELECT} AND (m.created_at, m.entry_id) < (?, ?) ORDER BY m.created_at DESC, m.entry_id DESC LIMIT ?`
            )
            .all(cursor.lastErrorAt, cursor.entryId, limit + 1)
        : this.database
            .prepare(`${AGGREGATE_SELECT} ORDER BY m.created_at DESC, m.entry_id DESC LIMIT ?`)
            .all(limit + 1)
      const entries = rows.slice(0, limit).map(fromListRow)
      const last = entries.at(-1)
      return {
        entries,
        ...(rows.length > limit && last
          ? { nextCursor: { lastErrorAt: last.lastErrorAt, entryId: last.entryId } }
          : {})
      }
    })
  }

  listHistory(raw: ListVocabularyMistakeHistoryInput): VocabularyMistakeHistoryPage {
    return this.withStorage(() => {
      const { entryId, limit, cursor } = listVocabularyMistakeHistoryInputSchema.parse(raw)
      const rows: unknown[] = cursor
        ? this.database
            .prepare(
              `SELECT id, submitted_meaning, created_at FROM vocabulary_practice_mistakes
               WHERE entry_id = ? AND (created_at, id) < (?, ?)
               ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(entryId, cursor.createdAt, cursor.id, limit + 1)
        : this.database
            .prepare(
              `SELECT id, submitted_meaning, created_at FROM vocabulary_practice_mistakes
               WHERE entry_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(entryId, limit + 1)
      const items = rows.slice(0, limit).map(fromHistoryRow)
      const last = items.at(-1)
      return {
        items,
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
      throw new VocabularyMistakesError('STORAGE_FAILED', { cause })
    }
  }
}

function fromListRow(raw: unknown): VocabularyMistakeListItem {
  const row = listRowSchema.parse(raw)
  return vocabularyMistakeListItemSchema.parse({
    entryId: row.entry_id,
    term: row.term,
    lastSubmittedMeaning: row.submitted_meaning,
    totalMistakes: row.total_mistakes,
    lastErrorAt: row.created_at
  })
}

function fromHistoryRow(raw: unknown): VocabularyMistakeHistoryItem {
  const row = historyRowSchema.parse(raw)
  return vocabularyMistakeHistoryItemSchema.parse({
    id: row.id,
    submittedMeaning: row.submitted_meaning,
    createdAt: row.created_at
  })
}
