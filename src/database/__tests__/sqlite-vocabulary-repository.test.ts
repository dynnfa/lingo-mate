import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { MIGRATIONS, migrateDatabase } from '../migrations'
import { SqliteVocabularyRepository } from '../sqlite-vocabulary-repository'
import { insertCommand } from '../../core/learning/vocabulary/__tests__/fixtures'
import {
  assertValidInsertCommand,
  VOCABULARY_INSERT_SQL,
  type VocabularyInsertCommand
} from '../../core/learning/vocabulary/vocabulary-insert'

const databases: Database.Database[] = []
const directories: string[] = []
function open(path = ':memory:'): Database.Database {
  const database = openDatabase(path)
  databases.push(database)
  return database
}
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

const V5_COLUMNS = [
  'id',
  'term',
  'phonetic',
  'meaning',
  'concept',
  'example_sentences',
  'model_id',
  'prompt_version',
  'created_at'
]
function columns(database: Database.Database): string[] {
  return (database.pragma('table_info(vocabulary)') as Array<{ name: string }>).map(
    (column) => column.name
  )
}

describe('vocabulary migrations', () => {
  it('upgrades v2 without altering conversations and is idempotent', () => {
    const database = new Database(':memory:')
    databases.push(database)
    for (const migration of MIGRATIONS.slice(0, 2)) migration.up(database)
    database.pragma('user_version = 2')
    database
      .prepare('INSERT INTO conversations VALUES (?, ?, ?)')
      .run('session', 'before', 'before')
    migrateDatabase(database)
    migrateDatabase(database)
    expect(database.pragma('user_version', { simple: true })).toBe(6)
    expect(database.prepare('SELECT id FROM conversations').all()).toEqual([{ id: 'session' }])
    expect(new SqliteVocabularyRepository(database).list({})).toEqual({ entries: [] })
  })
  it('rolls back v3 if index creation fails after creating the table', () => {
    const database = new Database(':memory:')
    databases.push(database)
    for (const migration of MIGRATIONS.slice(0, 2)) migration.up(database)
    database.pragma('user_version = 2')
    database.exec('CREATE INDEX vocabulary_created_at ON conversations(id)')
    expect(() => migrateDatabase(database)).toThrow()
    expect(database.pragma('user_version', { simple: true })).toBe(2)
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'vocabulary'").get()
    ).toBeUndefined()
  })
  it('upgrades v4 to the v5 nine-column vocabulary table and is idempotent', () => {
    const database = new Database(':memory:')
    databases.push(database)
    for (const migration of MIGRATIONS.slice(0, 4)) migration.up(database)
    database.pragma('user_version = 4')
    database.exec(`
      INSERT INTO vocabulary
      (id, term, lookup_key, word_language, explanation_language, analysis_json,
       analysis_schema_version, analysis_source, model_id, prompt_version, created_at, updated_at)
      VALUES
        ('11111111-1111-4111-8111-111111111111', 'apple', 'apple', 'en', 'zh-CN', '{}',
         1, 'llm', 'old-model', 'vocabulary-v1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('22222222-2222-4222-8222-222222222222', 'banana', 'banana', 'en', 'zh-CN', '{}',
         1, 'llm', 'old-model', 'vocabulary-v1', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    `)
    migrateDatabase(database)
    migrateDatabase(database)
    expect(database.pragma('user_version', { simple: true })).toBe(6)
    expect(columns(database)).toEqual(V5_COLUMNS)
    // 迁移保留身份与排序信息；四个内容字段按约定置 NULL，可读、可查重。
    const rows = database
      .prepare('SELECT * FROM vocabulary ORDER BY created_at ASC')
      .all() as Array<Record<string, string | null>>
    expect(rows.map((row) => row.id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    ])
    for (const row of rows) {
      expect(row.phonetic).toBeNull()
      expect(row.meaning).toBeNull()
      expect(row.concept).toBeNull()
      expect(row.example_sentences).toBeNull()
    }
    const repository = new SqliteVocabularyRepository(database)
    const listed = repository.list({})
    expect(listed.entries.map((entry) => entry.term)).toEqual(['banana', 'apple'])
    for (const entry of listed.entries) {
      expect(entry.phonetic).toBeNull()
      expect(entry.exampleSentences).toBeNull()
    }
    expect(repository.find('banana')?.id).toBe('22222222-2222-4222-8222-222222222222')
  })
  it('creates the same nine columns on a fresh database', () => {
    const database = open()
    expect(columns(database)).toEqual(V5_COLUMNS)
    expect(new SqliteVocabularyRepository(database).list({})).toEqual({ entries: [] })
  })
})

describe('vocabulary repository on the v5 schema', () => {
  it('round-trips new fields exactly, including quotes, newlines, and semicolons as data', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    const command = insertCommand(`it's a "test"; -- drop`, {
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-09-07T00:00:00.000Z'
    })
    command.parameters.meaning = "苹果'; DROP TABLE vocabulary;--\n第二行"
    command.parameters.example_sentences = JSON.stringify([
      "It's a test; isn't it?\nNew line here.",
      'Second sentence.'
    ])
    expect(repository.saveBatch([command])).toEqual([
      { id: command.parameters.id, status: 'saved' }
    ])
    const entry = repository.find(`it's a "test"; -- drop`)
    expect(entry).toMatchObject({
      id: command.parameters.id,
      term: command.parameters.term,
      phonetic: command.parameters.phonetic,
      meaning: command.parameters.meaning,
      concept: command.parameters.concept,
      exampleSentences: ["It's a test; isn't it?\nNew line here.", 'Second sentence.'],
      createdAt: command.parameters.created_at
    })
    // 危险字符只作为绑定数据保存，词表仍只有一行。
    const row = database.prepare('SELECT * FROM vocabulary').get() as Record<string, string>
    expect(row.meaning).toBe(command.parameters.meaning)
    expect(row.example_sentences).toBe(command.parameters.example_sentences)
    expect(row.term).toBe(command.parameters.term)
    expect(
      (database.prepare('SELECT COUNT(*) AS count FROM vocabulary').get() as { count: number })
        .count
    ).toBe(1)
  })
  it('keeps keyset pagination stable and hides storage-only fields', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vocabulary-'))
    directories.push(directory)
    const path = join(directory, 'test.sqlite')
    const stamp = '2026-09-07T00:00:00.000Z'
    const commands = ['apple', 'banana', 'orange'].map((term, index) =>
      insertCommand(term, { createdAt: stamp, id: `10000000-0000-4000-8000-00000000000${index}` })
    )
    new SqliteVocabularyRepository(open(path)).saveBatch(commands)
    const repository = new SqliteVocabularyRepository(open(path))
    const page1 = repository.list({ limit: 2 })
    const page2 = repository.list({ limit: 2, cursor: page1.nextCursor })
    expect([...page1.entries, ...page2.entries].map((entry) => entry.term)).toEqual([
      'orange',
      'banana',
      'apple'
    ])
    expect(page2.nextCursor).toBeUndefined()
    expect(page1.entries[0]).not.toHaveProperty('modelId')
    expect(page1.entries[0]).not.toHaveProperty('promptVersion')
  })
  it('reads rows written with older prompt versions', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    const command = insertCommand('apple', { promptVersion: 'vocabulary-v1' })
    repository.saveBatch([command])
    expect(repository.list({}).entries[0]).toMatchObject({ term: 'apple' })
  })
  it('normalizes lookup keys and keeps the earliest historical duplicate', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    const first = insertCommand('apple', { id: '10000000-0000-4000-8000-000000000001' })
    repository.saveBatch([first])
    // 直接写入同 key 的历史第二行：仓储查重应返回 created_at/id 顺序的最早行。
    const later = insertCommand('  Apple ', { id: '10000000-0000-4000-8000-000000000002' })
    database.prepare(VOCABULARY_INSERT_SQL).run(later.parameters)
    const duplicate = insertCommand('apple', { id: '10000000-0000-4000-8000-000000000003' })
    expect(repository.saveBatch([duplicate])).toEqual([
      { id: first.parameters.id, status: 'existing' }
    ])
    expect(repository.find('apple')?.id).toBe(first.parameters.id)
    const existing = repository.findExisting(['apple', 'missing'])
    expect(existing.get('apple')?.id).toBe(first.parameters.id)
    expect(existing.has('missing')).toBe(false)
    expect(database.prepare('SELECT COUNT(*) AS count FROM vocabulary').get()).toMatchObject({
      count: 2
    })
  })
  it('re-checks duplicates inside the commit transaction across concurrent connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vocabulary-'))
    directories.push(directory)
    const path = join(directory, 'test.sqlite')
    const own = open(path)
    const repository = new SqliteVocabularyRepository(own)
    const other = open(path)
    const concurrent = new SqliteVocabularyRepository(other)
    expect(repository.find('apple')).toBeUndefined()
    const committed = insertCommand('apple')
    concurrent.saveBatch([committed])
    // 第二个连接提交前已预查过词库，事务内重读索引仍必须识别对方已写入的词。
    expect(repository.saveBatch([insertCommand('apple')])).toEqual([
      { id: committed.parameters.id, status: 'existing' }
    ])
    expect(other.prepare('SELECT COUNT(*) AS count FROM vocabulary').get()).toMatchObject({
      count: 1
    })
  })
  it('rejects tampered commands and rolls back every pending insert on failure', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    const illegalSql: VocabularyInsertCommand = {
      ...insertCommand('apple'),
      sql: 'DELETE FROM vocabulary'
    }
    expect(() => repository.saveBatch([illegalSql])).toThrow('STORAGE_FAILED')
    const illegalBindings = insertCommand('apple')
    illegalBindings.parameters = { ...illegalBindings.parameters, id: 'not-a-uuid' }
    expect(() => repository.saveBatch([illegalBindings])).toThrow('STORAGE_FAILED')
    expect(() =>
      assertValidInsertCommand({
        ...insertCommand(),
        sql: `${VOCABULARY_INSERT_SQL}; DROP TABLE vocabulary`
      })
    ).toThrow()
    database.exec(
      "CREATE TRIGGER fail_second BEFORE INSERT ON vocabulary WHEN NEW.term = 'bad' BEGIN SELECT RAISE(ABORT, 'fixture'); END"
    )
    expect(() => repository.saveBatch([insertCommand('apple'), insertCommand('bad')])).toThrow(
      'STORAGE_FAILED'
    )
    expect(repository.list({}).entries).toHaveLength(0)
  })
  it('surfaces non-null invalid example sentences as a single-record data error', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    repository.saveBatch([insertCommand('apple')])
    database.exec("UPDATE vocabulary SET example_sentences = 'not json'")
    expect(() => repository.find('apple')).toThrow('STORAGE_FAILED')
    expect(() => repository.list({})).toThrow('STORAGE_FAILED')
    database.exec("UPDATE vocabulary SET example_sentences = '[]'")
    expect(() => repository.list({})).toThrow('STORAGE_FAILED')
    database.exec('UPDATE vocabulary SET example_sentences = NULL')
    expect(repository.list({}).entries[0]?.exampleSentences).toBeNull()
  })
  it('commits vocabulary and the durable batch report atomically, including zero inserts', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    const sessionId = randomUUID()
    const messageId = randomUUID()
    const executionId = randomUUID()
    const stamp = new Date().toISOString()
    database.prepare('INSERT INTO conversations VALUES (?, ?, ?)').run(sessionId, stamp, stamp)
    database
      .prepare('INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?)')
      .run(messageId, sessionId, 'user', '/vocabulary apple', stamp)
    database
      .prepare(
        `INSERT INTO conversation_skill_executions
         (id, session_id, user_message_id, skill_id, arguments_json, explanation_language,
          phase, created_at, updated_at)
         VALUES (?, ?, ?, 'vocabulary', ?, 'en', 'committing', ?, ?)`
      )
      .run(
        executionId,
        sessionId,
        messageId,
        JSON.stringify({ text: 'apple', wordLanguage: 'en' }),
        stamp,
        stamp
      )

    const command = insertCommand('apple')
    const batch = repository.saveBatchWithResult(executionId, [command], ([saved]) => ({
      requestId: randomUUID(),
      outcome: 'completed',
      explanationLanguage: 'en',
      items: [{ inputIndex: 0, term: 'apple', status: saved.status, entryId: saved.id }],
      counts: {
        total: 1,
        saved: saved.status === 'saved' ? 1 : 0,
        existing: saved.status === 'existing' ? 1 : 0,
        duplicate: 0,
        failed: 0
      }
    }))
    expect(batch.counts.saved).toBe(1)
    expect(
      database.prepare('SELECT phase, batch_json FROM conversation_skill_executions').get()
    ).toMatchObject({ phase: 'summarizing', batch_json: expect.stringContaining('"saved":1') })

    // 报告写入失败时整体回滚；零新增也允许保存报告。
    const zeroExecutionId = randomUUID()
    const zeroMessageId = randomUUID()
    database
      .prepare('INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?)')
      .run(zeroMessageId, sessionId, 'user', '/vocabulary orange', stamp)
    database
      .prepare(
        `INSERT INTO conversation_skill_executions
         (id, session_id, user_message_id, skill_id, arguments_json, explanation_language,
          phase, created_at, updated_at)
         VALUES (?, ?, ?, 'vocabulary', ?, 'en', 'committing', ?, ?)`
      )
      .run(
        zeroExecutionId,
        sessionId,
        zeroMessageId,
        JSON.stringify({ text: 'orange', wordLanguage: 'en' }),
        stamp,
        stamp
      )
    repository.saveBatchWithResult(zeroExecutionId, [], () => batch)
    expect(() =>
      repository.saveBatchWithResult(randomUUID(), [insertCommand('orange')], () => batch)
    ).toThrow('STORAGE_FAILED')
    expect(repository.find('orange')).toBeUndefined()
    // 同一执行记录不可重复提交报告。
    expect(() => repository.saveBatchWithResult(executionId, [], () => batch)).toThrow(
      'STORAGE_FAILED'
    )
  })
})
