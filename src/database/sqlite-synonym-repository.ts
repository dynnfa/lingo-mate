import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  synonymBatchSchema,
  synonymEntrySchema,
  synonymGroupPageSchema,
  synonymListInputSchema,
  type SynonymBatch,
  type SynonymEntry,
  type SynonymListInput
} from '../shared/synonym'
import type {
  SynonymRepository,
  SynonymGroupPage,
  SynonymWrite,
  SynonymSaveResult
} from '../core/learning/synonym/synonym-repository'
import { SynonymError } from '../core/learning/synonym/parse-synonym-input'
import { synonymToolSchemas } from '../core/tools/synonym-tools'

export class SqliteSynonymRepository implements SynonymRepository {
  constructor(private readonly database: Database.Database) {
    if (database.pragma('foreign_keys', { simple: true }) !== 1)
      throw new Error('Foreign keys must be enabled')
  }
  findExisting(words: string[]): Map<string, SynonymEntry> {
    return this.storage(() => {
      if (!words.length) return new Map()
      const rows = this.database
        .prepare(`SELECT * FROM synonym WHERE word IN (${words.map(() => '?').join(',')})`)
        .all(...words)
      return new Map(
        rows.map((row) => {
          const entry = synonymEntrySchema.parse(row)
          return [entry.word, entry]
        })
      )
    })
  }
  findGroups(cursor?: string): SynonymGroupPage {
    return this.storage(() => {
      const rows = this.database
        .prepare('SELECT id, meaning FROM synonym_group WHERE id > ? ORDER BY id LIMIT 6')
        .all(cursor ?? '') as Array<{ id: string; meaning: string }>
      const groups = rows.slice(0, 5).map((group) => {
        const words = this.database
          .prepare('SELECT * FROM synonym WHERE groupid = ? ORDER BY word LIMIT 101')
          .all(group.id)
          .map((row) => synonymEntrySchema.parse(row))
        // Never claim a group was fully inspected if its members exceed the response budget.
        if (words.length > 100) throw new SynonymError('SCAN_LIMIT')
        return { ...group, words }
      })
      const page = { groups, nextCursor: rows.length > 5 ? groups.at(-1)!.id : null }
      if (JSON.stringify(page).length > 60000) throw new SynonymError('SCAN_LIMIT')
      return page
    })
  }
  listGroups(raw: SynonymListInput): SynonymGroupPage {
    return this.storage(() =>
      this.database.transaction(() => {
        const { cursor } = synonymListInputSchema.parse(raw)
        // 界面列表：取 5 个非空组并额外探测一组判断后续页；不继承
        // 模型扫描的词数与字符预算，一页必须返回完整组。
        const rows = this.database
          .prepare(
            `SELECT id, meaning FROM synonym_group
               WHERE id > ? AND EXISTS (SELECT 1 FROM synonym WHERE groupid = synonym_group.id)
               ORDER BY id LIMIT 6`
          )
          .all(cursor ?? '') as Array<{ id: string; meaning: string }>
        const groups = rows.slice(0, 5).map((group) => ({
          ...group,
          words: this.database
            .prepare('SELECT * FROM synonym WHERE groupid = ? ORDER BY word, id')
            .all(group.id)
            .map((row) => synonymEntrySchema.parse(row))
        }))
        return synonymGroupPageSchema.parse({
          groups,
          nextCursor: rows.length > 5 ? groups.at(-1)!.id : null
        })
      })()
    )
  }
  saveReport(executionId: string, report: SynonymBatch): void {
    this.storage(() => {
      const batch = synonymBatchSchema.parse(report)
      const updated = this.database
        .prepare(
          `UPDATE conversation_skill_executions SET batch_json = ?, updated_at = ? WHERE id = ? AND skill_id = 'synonym'`
        )
        .run(JSON.stringify(batch), new Date().toISOString(), executionId)
      if (updated.changes !== 1) throw new Error('Missing synonym execution')
    })
  }
  saveWord(
    executionId: string,
    content: SynonymWrite,
    finalize: (result: SynonymSaveResult) => SynonymBatch
  ): SynonymSaveResult {
    return this.storage(() =>
      this.database
        .transaction(() => {
          const data =
            'groupid' in content
              ? synonymToolSchemas.add_synonym_to_group.parse(content)
              : synonymToolSchemas.create_synonym_group_and_add_word.parse(content)
          const existing = this.findExisting([data.word]).get(data.word)
          let result: SynonymSaveResult
          if (existing) result = { status: 'existing', entry: existing }
          else {
            const groupid = 'groupid' in data ? data.groupid : randomUUID()
            if ('groupid' in data) {
              if (!this.database.prepare('SELECT id FROM synonym_group WHERE id = ?').get(groupid))
                throw new Error('Missing synonym group')
            } else
              this.database
                .prepare('INSERT INTO synonym_group(id, meaning) VALUES (?, ?)')
                .run(groupid, data.groupMeaning)
            const entry = synonymEntrySchema.parse({
              id: randomUUID(),
              groupid,
              word: data.word,
              meaning: data.meaning,
              distinction: data.distinction
            })
            this.database
              .prepare(
                'INSERT INTO synonym(id, word, meaning, groupid, distinction) VALUES (@id, @word, @meaning, @groupid, @distinction)'
              )
              .run(entry)
            result = { status: 'saved', entry }
          }
          this.saveReport(executionId, finalize(result))
          return result
        })
        .immediate()
    )
  }
  private storage<T>(fn: () => T): T {
    try {
      return fn()
    } catch (cause) {
      if (cause instanceof SynonymError) throw cause
      throw new SynonymError('STORAGE_FAILED', { cause })
    }
  }
}
