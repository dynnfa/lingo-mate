import type Database from 'better-sqlite3'
import { z } from 'zod'
import {
  vocabularyEntrySchema,
  vocabularyBatchSchema,
  listVocabularyInputSchema,
  type VocabularyEntry,
  type ListVocabularyInput,
  type VocabularyBatch,
  type VocabularyPage
} from '../shared/vocabulary'
import {
  normalizeLookupKey,
  VocabularyError
} from '../core/learning/vocabulary/parse-vocabulary-input'
import {
  assertValidInsertCommand,
  exampleSentenceListSchema,
  type VocabularyInsertCommand
} from '../core/learning/vocabulary/vocabulary-insert'
import type { VocabularyRepository } from '../core/learning/vocabulary/vocabulary-repository'

// v5 词表 9 列；历史迁移行允许四个内容字段为 NULL，读取时不得因此失败。
const ROW_COLUMNS =
  'id, term, phonetic, meaning, concept, example_sentences, model_id, prompt_version, created_at'
const SELECT_ROWS = `SELECT ${ROW_COLUMNS} FROM vocabulary`

const rowSchema = z.object({
  id: z.string(),
  term: z.string(),
  phonetic: z.string().nullable(),
  meaning: z.string().nullable(),
  concept: z.string().nullable(),
  example_sentences: z.string().nullable(),
  model_id: z.string(),
  prompt_version: z.string(),
  created_at: z.string()
})
function fromRow(raw: unknown): VocabularyEntry {
  const row = rowSchema.parse(raw)
  return vocabularyEntrySchema.parse({
    id: row.id,
    term: row.term,
    phonetic: row.phonetic,
    meaning: row.meaning,
    concept: row.concept,
    exampleSentences: parseExampleSentences(row.example_sentences),
    createdAt: row.created_at
  })
}
// NULL 表示历史未回填内容；非空但不符编码的值属于单条记录的数据错误，
// 以 STORAGE_FAILED 暴露，不静默丢弃记录或整页。
function parseExampleSentences(value: string | null): string[] | null {
  if (value === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Invalid example_sentences encoding')
  }
  if (!exampleSentenceListSchema.safeParse(parsed).success) {
    throw new Error('Invalid example_sentences encoding')
  }
  return parsed as string[]
}

interface KeyIndexRow {
  id: string
  term: string
}

export class SqliteVocabularyRepository implements VocabularyRepository {
  constructor(private readonly database: Database.Database) {}

  find(lookupKey: string): VocabularyEntry | undefined {
    return this.withStorage(() => {
      const rows = this.database
        .prepare(`${SELECT_ROWS} ORDER BY created_at ASC, id ASC`)
        .all() as unknown[]
      const row = rows.find((raw) => normalizeLookupKey((raw as KeyIndexRow).term) === lookupKey)
      return row ? fromRow(row) : undefined
    })
  }

  findExisting(lookupKeys: string[]): Map<string, VocabularyEntry> {
    return this.withStorage(() => {
      const wanted = new Set(lookupKeys)
      const found = new Map<string, VocabularyEntry>()
      if (!wanted.size) return found
      const rows = this.database
        .prepare(`${SELECT_ROWS} ORDER BY created_at ASC, id ASC`)
        .all() as unknown[]
      for (const raw of rows) {
        const key = normalizeLookupKey((raw as KeyIndexRow).term)
        if (wanted.has(key) && !found.has(key)) found.set(key, fromRow(raw))
      }
      return found
    })
  }

  saveBatch(
    commands: VocabularyInsertCommand[]
  ): Array<{ id: string; status: 'saved' | 'existing' }> {
    return this.withStorage(() =>
      this.database.transaction(() => this.saveCommands(commands)).immediate()
    )
  }

  saveBatchWithResult(
    executionId: string,
    commands: VocabularyInsertCommand[],
    finalize: (saved: Array<{ id: string; status: 'saved' | 'existing' }>) => VocabularyBatch
  ): VocabularyBatch {
    return this.withStorage(() =>
      this.database
        .transaction(() => {
          const saved = this.saveCommands(commands)
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
      const rows: unknown[] = cursor
        ? this.database
            .prepare(
              `${SELECT_ROWS} WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(cursor.createdAt, cursor.id, limit + 1)
        : this.database
            .prepare(`${SELECT_ROWS} ORDER BY created_at DESC, id DESC LIMIT ?`)
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

  deleteById(id: string): boolean {
    // id 只作为绑定参数参与参数化删除；不存在时 changes 为 0，返回幂等结果。
    return this.withStorage(() => {
      const result = this.database.prepare('DELETE FROM vocabulary WHERE id = ?').run(id)
      return result.changes === 1
    })
  }

  private withStorage<T>(operation: () => T): T {
    try {
      return operation()
    } catch (cause) {
      throw new VocabularyError('STORAGE_FAILED', { cause })
    }
  }

  private saveCommands(
    commands: VocabularyInsertCommand[]
  ): Array<{ id: string; status: 'saved' | 'existing' }> {
    // 词表没有 term 唯一约束；查重完全依赖本入口在事务内维护的 key 索引。
    const index = this.loadKeyIndex()
    return commands.map((command) => {
      assertValidInsertCommand(command)
      const key = normalizeLookupKey(command.parameters.term)
      const existingId = index.get(key)
      if (existingId !== undefined) return { id: existingId, status: 'existing' as const }
      this.database.prepare(command.sql).run(command.parameters)
      index.set(key, command.parameters.id)
      return { id: command.parameters.id, status: 'saved' as const }
    })
  }

  // 每次提交在事务内重建索引：同 key 历史多行按 created_at ASC, id ASC 取首个，
  // 本批新写入即时并入索引，两个连接并发写入也不会重复新增。
  private loadKeyIndex(): Map<string, string> {
    const rows = this.database
      .prepare('SELECT id, term FROM vocabulary ORDER BY created_at ASC, id ASC')
      .all() as KeyIndexRow[]
    const index = new Map<string, string>()
    for (const row of rows) {
      const key = normalizeLookupKey(row.term)
      if (!index.has(key)) index.set(key, row.id)
    }
    return index
  }
}
