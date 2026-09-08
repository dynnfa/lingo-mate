import type Database from 'better-sqlite3'
import {
  phraseBatchSchema,
  phraseEntrySchema,
  type PhraseBatch,
  type PhraseEntry
} from '../shared/phrase'
import { PhraseError } from '../core/learning/phrase/parse-phrase-input'
import {
  assertValidPhraseInsertContent,
  type PhraseInsertContent
} from '../core/tools/phrase-tools'
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
