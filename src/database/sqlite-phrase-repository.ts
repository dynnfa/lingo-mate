import type Database from 'better-sqlite3'
import {
  listPhraseInputSchema,
  phraseBatchSchema,
  phraseEntrySchema,
  type ListPhraseInput,
  type PhraseBatch,
  type PhraseEntry,
  type PhrasePage
} from '../shared/phrase'
import { PhraseError } from '../core/learning/phrase/parse-phrase-input'
import {
  assertValidPhraseInsertContent,
  type PhraseInsertContent
} from '../core/learning/phrase/phrase-tools'
import type { PhraseRepository, PhraseSaveStatus } from '../core/learning/phrase/phrase-repository'

// 应用内部固定的参数化 INSERT：唯一约束冲突不覆盖既有内容。
// 模型只提供绑定值；表名、列名与 SQL 结构均不可由模型指定。
const PHRASE_INSERT_SQL = `INSERT INTO phrase (phrase, explantation, example)
VALUES (@phrase, @explantation, @example)
ON CONFLICT(phrase) DO NOTHING`

export class SqlitePhraseRepository implements PhraseRepository {
  constructor(private readonly database: Database.Database) {}

  findExisting(phrases: string[]): Map<string, PhraseEntry> {
    return this.withStorage(() => {
      const found = new Map<string, PhraseEntry>()
      const unique = [...new Set(phrases)]
      if (!unique.length) return found
      const placeholders = unique.map(() => '?').join(', ')
      const rows = this.database
        .prepare(
          `SELECT phrase, explantation, example FROM phrase WHERE phrase IN (${placeholders})`
        )
        .all(...unique) as unknown[]
      for (const raw of rows) {
        const entry = phraseEntrySchema.parse(raw)
        found.set(entry.phrase, entry)
      }
      return found
    })
  }

  saveBatchWithResult(
    executionId: string,
    contents: PhraseInsertContent[],
    finalize: (saved: PhraseSaveStatus[]) => PhraseBatch
  ): PhraseBatch {
    return this.withStorage(() =>
      this.database
        .transaction(() => {
          const saved = this.saveContents(contents)
          const batch = phraseBatchSchema.parse(finalize(saved))
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

  list(raw: ListPhraseInput): PhrasePage {
    return this.withStorage(() => {
      const { limit, cursor } = listPhraseInputSchema.parse(raw)
      // 排序与游标比较同为 COLLATE BINARY：主键按原文精确比较，删除游标行不影响后续分页。
      const rows: unknown[] = cursor
        ? this.database
            .prepare(
              `SELECT phrase, explantation, example FROM phrase
               WHERE phrase > ? COLLATE BINARY
               ORDER BY phrase COLLATE BINARY ASC
               LIMIT ?`
            )
            .all(cursor, limit + 1)
        : this.database
            .prepare(
              `SELECT phrase, explantation, example FROM phrase
               ORDER BY phrase COLLATE BINARY ASC
               LIMIT ?`
            )
            .all(limit + 1)
      const entries = rows.slice(0, limit).map((row) => phraseEntrySchema.parse(row))
      const last = entries.at(-1)
      return {
        entries,
        ...(rows.length > limit && last ? { nextCursor: last.phrase } : {})
      }
    })
  }

  deleteByPhrase(phrase: string): boolean {
    // phrase 只作为绑定参数参与参数化删除；不存在时 changes 为 0，返回幂等结果。
    return this.withStorage(() => {
      const result = this.database.prepare('DELETE FROM phrase WHERE phrase = ?').run(phrase)
      return result.changes === 1
    })
  }

  private withStorage<T>(operation: () => T): T {
    try {
      return operation()
    } catch (cause) {
      throw new PhraseError('STORAGE_FAILED', { cause })
    }
  }

  private saveContents(contents: PhraseInsertContent[]): PhraseSaveStatus[] {
    const statement = this.database.prepare(PHRASE_INSERT_SQL)
    return contents.map((content) => {
      assertValidPhraseInsertContent(content)
      // 冲突（含并发写入与重复提交）返回 existing，不覆盖解释或例句。
      const result = statement.run(content)
      return result.changes === 1 ? ('saved' as const) : ('existing' as const)
    })
  }
}
