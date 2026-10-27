import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { MIGRATIONS, migrateDatabase } from '../migrations'
import { SqlitePhraseRepository } from '../sqlite-phrase-repository'
import { content } from '../../core/learning/phrase/__tests__/fixtures'
import type { PhraseInsertContent } from '../../core/learning/phrase/phrase-tools'
import type { PhraseSaveStatus } from '../../core/learning/phrase/phrase-repository'
import type { PhraseBatch } from '../../shared/phrase'

const databases: Database.Database[] = []
const directories: string[] = []
function open(path = ':memory:'): Database.Database {
  const database = openDatabase(path)
  databases.push(database)
  return database
}
function commit(database: Database.Database, contents: PhraseInsertContent[]): PhraseSaveStatus[] {
  const sessionId = randomUUID()
  const messageId = randomUUID()
  const executionId = randomUUID()
  const stamp = new Date().toISOString()
  database
    .prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)')
    .run(sessionId, stamp, stamp, 'Test')
  database
    .prepare('INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?)')
    .run(messageId, sessionId, 'user', '/phrase test', stamp)
  database
    .prepare(
      `
    INSERT INTO conversation_skill_executions
      (id, session_id, user_message_id, skill_id, arguments_json, explanation_language, phase, created_at, updated_at)
    VALUES (?, ?, ?, 'phrase', '{}', 'en', 'committing', ?, ?)
  `
    )
    .run(executionId, sessionId, messageId, stamp, stamp)
  let statuses: PhraseSaveStatus[] = []
  new SqlitePhraseRepository(database).saveBatchWithResult(executionId, contents, (saved) => {
    statuses = saved
    return {
      requestId: randomUUID(),
      outcome: 'completed',
      explanationLanguage: 'en',
      items: contents.map((entry, inputIndex) => ({
        inputIndex,
        input: entry.phrase,
        phrase: entry.phrase,
        status: saved[inputIndex]
      })),
      counts: {
        total: contents.length,
        saved: saved.filter((status) => status === 'saved').length,
        existing: saved.filter((status) => status === 'existing').length,
        duplicate: 0,
        failed: 0
      }
    }
  })
  return statuses
}
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe('phrase migrations', () => {
  it('creates the phrase table on a fresh database and is idempotent', () => {
    const database = open()
    migrateDatabase(database)
    const columns = (
      database.pragma('table_info(phrase)') as Array<{ name: string; notnull: number; pk: number }>
    ).map((column) => column.name)
    expect(columns).toEqual(['phrase', 'explantation', 'example'])
  })
  it('upgrades v8 with existing skill executions and usage rows, preserving data', () => {
    const database = new Database(':memory:')
    databases.push(database)
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 8)) migration.up(database)
    database.pragma('user_version = 8')
    const stamp = '2026-09-01T00:00:00.000Z'
    database.exec(`
      INSERT INTO conversations (id, created_at, updated_at, title) VALUES ('s1', '${stamp}', '${stamp}', 'Title');
      INSERT INTO conversation_messages (id, session_id, role, content, created_at)
        VALUES ('m1', 's1', 'user', '/vocabulary apple', '${stamp}');
      INSERT INTO conversation_skill_executions
        (id, session_id, user_message_id, skill_id, arguments_json, explanation_language, phase, created_at, updated_at)
        VALUES ('e1', 's1', 'm1', 'vocabulary', '{}', 'en', 'completed', '${stamp}', '${stamp}');
      INSERT INTO llm_request_usage (id, operation, model_id, started_at, status, usage_status)
        VALUES ('u1', 'vocabulary_analysis', 'old-model', 1, 'completed', 'missing');
    `)
    migrateDatabase(database)
    migrateDatabase(database)
    // 历史 Vocabulary 技能执行与用量记录保留
    expect(database.prepare('SELECT skill_id FROM conversation_skill_executions').get()).toEqual({
      skill_id: 'vocabulary'
    })
    expect(database.prepare('SELECT operation FROM llm_request_usage').get()).toEqual({
      operation: 'vocabulary_analysis'
    })
    // 新约束接受 phrase 技能与 phrase_analysis 用量
    database
      .prepare('INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?)')
      .run('m2', 's1', 'user', '/phrase look forward to', stamp)
    expect(() =>
      database
        .prepare(
          `INSERT INTO conversation_skill_executions
           (id, session_id, user_message_id, skill_id, arguments_json, explanation_language, phase, created_at, updated_at)
           VALUES ('e2', 's1', 'm2', 'phrase', '{}', 'en', 'started', '${stamp}', '${stamp}')`
        )
        .run()
    ).not.toThrow()
    expect(() =>
      database
        .prepare(
          `INSERT INTO llm_request_usage (id, operation, model_id, started_at, status, usage_status)
           VALUES ('u2', 'phrase_analysis', 'model', 2, 'completed', 'missing')`
        )
        .run()
    ).not.toThrow()
  })
  it('rejects blank, overlong, and mistyped phrase rows via table constraints', () => {
    const database = open()
    const insert = (phrase: unknown, explantation: unknown, example: unknown): void => {
      database
        .prepare('INSERT INTO phrase (phrase, explantation, example) VALUES (?, ?, ?)')
        .run(phrase, explantation, example)
    }
    expect(() => insert('   ', '解释', 'Example sentence.')).toThrow()
    expect(() => insert('x'.repeat(201), '解释', 'Example sentence.')).toThrow()
    expect(() => insert('ok', '   ', 'Example sentence.')).toThrow()
    expect(() => insert('ok', 'x'.repeat(2001), 'Example sentence.')).toThrow()
    expect(() => insert('ok', '解释', ' ')).toThrow()
    expect(() => insert('ok', '解释', 'x'.repeat(1001))).toThrow()
    expect(() => insert(null, '解释', 'Example sentence.')).toThrow()
    insert('ok', '解释', 'Example sentence.')
    expect(
      (database.prepare('SELECT COUNT(*) AS count FROM phrase').get() as { count: number }).count
    ).toBe(1)
  })
})

describe('phrase repository on the v9 schema', () => {
  it('round-trips content exactly, including quotes, newlines, and SQL fragments as data', () => {
    const database = open()
    const repository = new SqlitePhraseRepository(database)
    const tricky: PhraseInsertContent = content(`it's a "test"; -- drop`, {
      explantation: "期待'; DROP TABLE phrase;--\n第二行",
      example: "It's a test; isn't it?\nNew line here."
    })
    expect(commit(database, [tricky])).toEqual(['saved'])
    const existing = repository.findExisting([`it's a "test"; -- drop`, 'missing'])
    expect(existing.get(`it's a "test"; -- drop`)).toEqual(tricky)
    expect(existing.has('missing')).toBe(false)
    expect(
      (database.prepare('SELECT COUNT(*) AS count FROM phrase').get() as { count: number }).count
    ).toBe(1)
  })
  it('treats case differences as distinct entries and conflicts as existing without overwrite', () => {
    const database = open()
    const repository = new SqlitePhraseRepository(database)
    commit(database, [content('look forward to')])
    // 不同大小写视为不同项
    expect(commit(database, [content('LOOK FORWARD TO')])).toEqual(['saved'])
    // 精确冲突返回 existing，且不覆盖原内容
    expect(
      commit(database, [
        content('look forward to', {
          explantation: 'should not overwrite',
          example: 'should not overwrite'
        })
      ])
    ).toEqual(['existing'])
    const kept = repository.findExisting(['look forward to']).get('look forward to')
    expect(kept?.explantation).toBe('期待，盼望（某件将发生的事）。')
    expect(
      (database.prepare('SELECT COUNT(*) AS count FROM phrase').get() as { count: number }).count
    ).toBe(2)
  })
  it('re-checks duplicates inside the commit transaction across concurrent connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phrase-'))
    directories.push(directory)
    const path = join(directory, 'test.sqlite')
    const own = open(path)
    const repository = new SqlitePhraseRepository(own)
    const other = open(path)
    const committed = content('look forward to')
    expect(repository.findExisting([committed.phrase]).size).toBe(0)
    commit(other, [committed])
    // 第二个连接提交前已预查过，事务内唯一约束仍必须识别对方已写入的短语。
    expect(commit(own, [content('look forward to')])).toEqual(['existing'])
    expect(
      (other.prepare('SELECT COUNT(*) AS count FROM phrase').get() as { count: number }).count
    ).toBe(1)
  })
  it('rejects invalid content objects at the execution boundary', () => {
    const database = open()
    expect(() => commit(database, [{ ...content(), phrase: 'x'.repeat(201) }])).toThrow(
      'STORAGE_FAILED'
    )
    expect(() => commit(database, [{ ...content(), example: '' }])).toThrow('STORAGE_FAILED')
    expect(
      (database.prepare('SELECT COUNT(*) AS count FROM phrase').get() as { count: number }).count
    ).toBe(0)
  })
  it('commits phrases and the durable batch report atomically, including zero inserts', () => {
    const database = open()
    const repository = new SqlitePhraseRepository(database)
    const sessionId = randomUUID()
    const messageId = randomUUID()
    const executionId = randomUUID()
    const stamp = new Date().toISOString()
    database
      .prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)')
      .run(sessionId, stamp, stamp, 'Test title')
    database
      .prepare('INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?)')
      .run(messageId, sessionId, 'user', '/phrase look forward to', stamp)
    database
      .prepare(
        `INSERT INTO conversation_skill_executions
         (id, session_id, user_message_id, skill_id, arguments_json, explanation_language,
          phase, created_at, updated_at)
         VALUES (?, ?, ?, 'phrase', ?, 'en', 'committing', ?, ?)`
      )
      .run(
        executionId,
        sessionId,
        messageId,
        JSON.stringify({ text: 'look forward to', wordLanguage: 'en' }),
        stamp,
        stamp
      )

    const reportFor = (saved: Array<'saved' | 'existing'>): PhraseBatch => ({
      requestId: randomUUID(),
      outcome: 'completed',
      explanationLanguage: 'en',
      items: [
        {
          inputIndex: 0,
          input: 'look forward to',
          phrase: 'look forward to',
          status: saved[0] ?? 'saved'
        }
      ],
      counts: {
        total: 1,
        saved: saved.filter((status) => status === 'saved').length,
        existing: saved.filter((status) => status === 'existing').length,
        duplicate: 0,
        failed: 0
      }
    })

    const batch = repository.saveBatchWithResult(executionId, [content()], ([saved]) =>
      reportFor([saved])
    )
    expect(batch.counts.saved).toBe(1)
    expect(
      database.prepare('SELECT phase, batch_json FROM conversation_skill_executions').get()
    ).toMatchObject({ phase: 'summarizing', batch_json: expect.stringContaining('"saved":1') })

    // 零新增也允许保存报告；缺失的执行记录与重复提交都失败。
    const zeroExecutionId = randomUUID()
    const zeroMessageId = randomUUID()
    database
      .prepare('INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?)')
      .run(zeroMessageId, sessionId, 'user', '/phrase break even', stamp)
    database
      .prepare(
        `INSERT INTO conversation_skill_executions
         (id, session_id, user_message_id, skill_id, arguments_json, explanation_language,
          phase, created_at, updated_at)
         VALUES (?, ?, ?, 'phrase', ?, 'en', 'committing', ?, ?)`
      )
      .run(
        zeroExecutionId,
        sessionId,
        zeroMessageId,
        JSON.stringify({ text: 'break even', wordLanguage: 'en' }),
        stamp,
        stamp
      )
    repository.saveBatchWithResult(zeroExecutionId, [], () => batch)
    expect(() =>
      repository.saveBatchWithResult(randomUUID(), [content('break even')], () => batch)
    ).toThrow('STORAGE_FAILED')
    expect(repository.findExisting(['break even']).has('break even')).toBe(false)
    // 同一执行记录不可重复提交报告（重放幂等：内容已写入也整体回滚为无副作用）
    expect(() => repository.saveBatchWithResult(executionId, [], () => batch)).toThrow(
      'STORAGE_FAILED'
    )
  })
  it('rolls back every pending insert when the report is inconsistent', () => {
    const database = open()
    const repository = new SqlitePhraseRepository(database)
    const executionId = randomUUID()
    const sessionId = randomUUID()
    const messageId = randomUUID()
    const stamp = new Date().toISOString()
    database
      .prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)')
      .run(sessionId, stamp, stamp, 'Title')
    database
      .prepare('INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?)')
      .run(messageId, sessionId, 'user', '/phrase a', stamp)
    database
      .prepare(
        `INSERT INTO conversation_skill_executions
         (id, session_id, user_message_id, skill_id, arguments_json, explanation_language,
          phase, created_at, updated_at)
         VALUES (?, ?, ?, 'phrase', '{}', 'en', 'committing', ?, ?)`
      )
      .run(executionId, sessionId, messageId, stamp, stamp)
    const inconsistent = (): PhraseBatch => ({
      requestId: 'not-a-uuid',
      outcome: 'completed',
      explanationLanguage: 'en',
      items: [],
      counts: { total: 0, saved: 0, existing: 0, duplicate: 0, failed: 0 }
    })
    expect(() =>
      repository.saveBatchWithResult(executionId, [content('a'), content('b')], inconsistent)
    ).toThrow('STORAGE_FAILED')
    expect(
      (database.prepare('SELECT COUNT(*) AS count FROM phrase').get() as { count: number }).count
    ).toBe(0)
  })
})

describe('phrase repository list and delete', () => {
  function seed(database: Database.Database, phrases: string[]): SqlitePhraseRepository {
    const repository = new SqlitePhraseRepository(database)
    for (const phrase of phrases) commit(database, [content(phrase)])
    return repository
  }

  it('lists pages in stable BINARY order with no overlap or gap across cursors', () => {
    const database = open()
    const repository = seed(database, [
      'apples',
      'Zebra',
      'apple',
      'Break even',
      'look forward to',
      'break even'
    ])

    // BINARY 排序：大小写敏感且按字节序，'Zebra' < 'apple'，'apple' < 'apples'。
    const first = repository.list({ limit: 2 })
    expect(first.entries.map((entry) => entry.phrase)).toEqual(['Break even', 'Zebra'])
    expect(first.nextCursor).toBe('Zebra')

    const second = repository.list({ limit: 2, cursor: first.nextCursor })
    expect(second.entries.map((entry) => entry.phrase)).toEqual(['apple', 'apples'])
    expect(second.nextCursor).toBe('apples')

    const third = repository.list({ limit: 2, cursor: second.nextCursor })
    expect(third.entries.map((entry) => entry.phrase)).toEqual(['break even', 'look forward to'])
    expect(third.nextCursor).toBeUndefined()

    // 末页恰好取满且没有下一页时，nextCursor 缺省而不是补一个空游标。
    const exact = repository.list({ limit: 6 })
    expect(exact.entries).toHaveLength(6)
    expect(exact.nextCursor).toBeUndefined()
  })

  it('deletes exactly one entry by its verbatim primary key', () => {
    const database = open()
    const repository = seed(database, ['look forward to', 'LOOK FORWARD TO', 'look forward!'])

    expect(repository.deleteByPhrase('look forward to')).toBe(true)
    // 大小写不同、前缀相近的短语不受影响。
    expect(repository.findExisting(['LOOK FORWARD TO', 'look forward!']).size).toBe(2)
    expect(repository.findExisting(['look forward to']).size).toBe(0)
    // 目标已不存在：幂等返回 false。
    expect(repository.deleteByPhrase('look forward to')).toBe(false)
    expect(repository.deleteByPhrase('missing')).toBe(false)
  })

  it('keeps paging by value after the cursor row is deleted', () => {
    const database = open()
    const repository = seed(database, ['a phrase', 'b phrase', 'c phrase'])

    const first = repository.list({ limit: 1 })
    expect(first.nextCursor).toBe('a phrase')
    expect(repository.deleteByPhrase('a phrase')).toBe(true)

    // 游标行已删除：值比较不受影响，下一页从 b phrase 继续。
    const second = repository.list({ limit: 2, cursor: first.nextCursor })
    expect(second.entries.map((entry) => entry.phrase)).toEqual(['b phrase', 'c phrase'])
    expect(second.nextCursor).toBeUndefined()
  })

  it('preserves conversation history and batch reports when deleting phrases', () => {
    const database = open()
    const repository = seed(database, ['look forward to'])

    expect(repository.deleteByPhrase('look forward to')).toBe(true)
    expect(
      (
        database.prepare('SELECT COUNT(*) AS count FROM conversation_messages').get() as {
          count: number
        }
      ).count
    ).toBe(1)
    const execution = database
      .prepare('SELECT batch_json FROM conversation_skill_executions')
      .get() as {
      batch_json: string | null
    }
    expect(execution.batch_json).toContain('"saved":1')
  })

  it('wraps list and delete storage failures as STORAGE_FAILED', () => {
    const database = open()
    const repository = seed(database, ['look forward to'])
    database.exec('DROP TABLE phrase')

    expect(() => repository.list({})).toThrow('STORAGE_FAILED')
    expect(() => repository.deleteByPhrase('look forward to')).toThrow('STORAGE_FAILED')
  })
})
