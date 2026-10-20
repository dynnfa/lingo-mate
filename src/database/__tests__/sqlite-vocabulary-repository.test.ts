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
  it('upgrades v2, clears legacy conversations and is idempotent', () => {
    const database = new Database(':memory:')
    databases.push(database)
    for (const migration of MIGRATIONS.slice(0, 2)) migration.up(database)
    database.pragma('user_version = 2')
    database
      .prepare('INSERT INTO conversations VALUES (?, ?, ?)')
      .run('session', 'before', 'before')
    migrateDatabase(database)
    migrateDatabase(database)
    expect(database.pragma('user_version', { simple: true })).toBe(12)
    expect(database.prepare('SELECT id FROM conversations').all()).toEqual([])
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
    expect(database.pragma('user_version', { simple: true })).toBe(12)
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
      phonetic: JSON.parse(command.parameters.phonetic),
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
  it('deletes exactly one record by id and keeps same-term history intact', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    const stamp = '2026-09-07T00:00:00.000Z'
    const first = insertCommand('apple', {
      id: '10000000-0000-4000-8000-000000000001',
      createdAt: stamp
    })
    repository.saveBatch([first])
    // 直接写入同 term 的历史第二行，模拟迁移遗留的同名记录。
    const second = insertCommand('apple', {
      id: '10000000-0000-4000-8000-000000000002',
      createdAt: '2026-09-08T00:00:00.000Z'
    })
    database.prepare(VOCABULARY_INSERT_SQL).run(second.parameters)

    expect(repository.deleteById(first.parameters.id)).toBe(true)
    expect(database.prepare('SELECT COUNT(*) AS count FROM vocabulary').get()).toMatchObject({
      count: 1
    })
    expect(repository.list({}).entries.map((entry) => entry.id)).toEqual([second.parameters.id])
    expect(repository.find('apple')?.id).toBe(second.parameters.id)
  })
  it('treats deleting a missing id as an idempotent no-op', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    const command = insertCommand('apple')
    repository.saveBatch([command])

    expect(repository.deleteById('99999999-9999-4999-8999-999999999999')).toBe(false)
    expect(database.prepare('SELECT COUNT(*) AS count FROM vocabulary').get()).toMatchObject({
      count: 1
    })
    expect(repository.deleteById(command.parameters.id)).toBe(true)
    expect(repository.deleteById(command.parameters.id)).toBe(false)
  })
  it('wraps delete storage failures as STORAGE_FAILED', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    database.exec('DROP TABLE vocabulary')
    expect(() => repository.deleteById('11111111-1111-4111-8111-111111111111')).toThrow(
      'STORAGE_FAILED'
    )
  })
  it('keeps keyset pagination usable after the cursor row is deleted', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    const stamp = '2026-09-07T00:00:00.000Z'
    const commands = ['apple', 'banana', 'orange', 'peach'].map((term, index) =>
      insertCommand(term, { createdAt: stamp, id: `10000000-0000-4000-8000-00000000000${index}` })
    )
    repository.saveBatch(commands)
    const page1 = repository.list({ limit: 2 })
    expect(page1.entries.map((entry) => entry.term)).toEqual(['peach', 'orange'])
    // 删除游标行（orange）后按原游标继续读取，仍能拿到剩余两行。
    expect(repository.deleteById(page1.nextCursor?.id as string)).toBe(true)
    const page2 = repository.list({ limit: 2, cursor: page1.nextCursor })
    expect(page2.entries.map((entry) => entry.term)).toEqual(['banana', 'apple'])
    expect(page2.nextCursor).toBeUndefined()
  })
  it('deleting vocabulary records leaves conversations and skill reports untouched', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    const stamp = new Date().toISOString()
    const sessionId = randomUUID()
    const messageId = randomUUID()
    const executionId = randomUUID()
    database
      .prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)')
      .run(sessionId, stamp, stamp, 'Test title')
    database
      .prepare('INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?)')
      .run(messageId, sessionId, 'user', '/vocabulary apple', stamp)
    database
      .prepare(
        `INSERT INTO conversation_skill_executions
         (id, session_id, user_message_id, skill_id, arguments_json, explanation_language,
          phase, batch_json, created_at, updated_at)
         VALUES (?, ?, ?, 'vocabulary', ?, 'en', 'summarizing', ?, ?, ?)`
      )
      .run(
        executionId,
        sessionId,
        messageId,
        JSON.stringify({ text: 'apple', wordLanguage: 'en' }),
        JSON.stringify({ saved: 1 }),
        stamp,
        stamp
      )
    const command = insertCommand('apple')
    repository.saveBatch([command])

    expect(repository.deleteById(command.parameters.id)).toBe(true)
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM conversation_messages').get()
    ).toMatchObject({ count: 1 })
    expect(
      database.prepare('SELECT batch_json FROM conversation_skill_executions').get()
    ).toMatchObject({ batch_json: JSON.stringify({ saved: 1 }) })
  })
  it('commits vocabulary and the durable batch report atomically, including zero inserts', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    const sessionId = randomUUID()
    const messageId = randomUUID()
    const executionId = randomUUID()
    const stamp = new Date().toISOString()
    database
      .prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)')
      .run(sessionId, stamp, stamp, 'Test title')
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

describe('vocabulary practice sampling', () => {
  // 直接 SQL 插入：插入命令要求 meaning 非空，而抽词测试需要历史 NULL 行。
  function seeded(words: Array<{ term: string; meaning: string | null }>): {
    repository: SqliteVocabularyRepository
    database: Database.Database
  } {
    const database = open()
    const insert = database.prepare(
      `INSERT INTO vocabulary
       (id, term, phonetic, meaning, concept, example_sentences, model_id, prompt_version, created_at)
       VALUES (?, ?, NULL, ?, NULL, NULL, 'fixture-model', 'vocabulary-tools-v2', ?)`
    )
    words.forEach((word, index) => {
      insert.run(
        `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        word.term,
        word.meaning,
        `2026-09-07T0${index}:00:00.000Z`
      )
    })
    return { repository: new SqliteVocabularyRepository(database), database }
  }

  it('returns unique random entries bounded by the requested count', () => {
    const { repository } = seeded([
      { term: 'apple', meaning: '苹果' },
      { term: 'banana', meaning: '香蕉' },
      { term: 'orange', meaning: '橙子' },
      { term: 'peach', meaning: '桃子' },
      { term: 'grape', meaning: null }
    ])
    const sampled = repository.sampleRandom(3)
    expect(sampled).toHaveLength(3)
    const ids = new Set(sampled.map((entry) => entry.id))
    expect(ids.size).toBe(3)
    for (const entry of sampled) {
      expect(['apple', 'banana', 'orange', 'peach', 'grape']).toContain(entry.term)
    }
    // 连续抽样同样不出现重复 ID
    for (let attempt = 0; attempt < 5; attempt++) {
      const again = repository.sampleRandom(5)
      expect(new Set(again.map((entry) => entry.id)).size).toBe(5)
    }
  })

  it('returns every entry once when the vocabulary is smaller than requested', () => {
    const { repository } = seeded([
      { term: 'apple', meaning: '苹果' },
      { term: 'banana', meaning: null }
    ])
    const sampled = repository.sampleRandom(10)
    expect(sampled.map((entry) => entry.term).sort()).toEqual(['apple', 'banana'])
    // 历史 NULL meaning 原样保留，不阻断抽词
    expect(sampled.find((entry) => entry.term === 'banana')?.meaning).toBeNull()
  })

  it('returns an empty array for an empty vocabulary', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    expect(repository.sampleRandom(5)).toEqual([])
  })

  it('rejects invalid counts and wraps storage failures as STORAGE_FAILED', () => {
    const { repository, database } = seeded([{ term: 'apple', meaning: '苹果' }])
    expect(() => repository.sampleRandom(0)).toThrow()
    expect(() => repository.sampleRandom(-1)).toThrow()
    expect(() => repository.sampleRandom(1.5)).toThrow()
    database.exec('DROP TABLE vocabulary')
    expect(() => repository.sampleRandom(1)).toThrow('STORAGE_FAILED')
  })
})

it('exports a full sorted snapshot beyond page size, including manual-import content', () => {
  const repository = new SqliteVocabularyRepository(open())
  repository.saveBatch(
    Array.from({ length: 115 }, (_, i) =>
      insertCommand(`word-${i}`, { modelId: 'manual-import', promptVersion: 'vocabulary-excel-v1' })
    )
  )
  const entries = repository.exportAll()
  expect(entries).toHaveLength(115)
  expect(entries.slice(0, 50)).toEqual(repository.list({}).entries)
})

it('reads multiple phonetics and legacy slash, bracket and NULL values without rewriting rows', () => {
  const database = open()
  const repository = new SqliteVocabularyRepository(database)
  const command = insertCommand('read')
  command.parameters.phonetic = JSON.stringify(['/riːd/', '/rɛd/'])
  repository.saveBatch([command])
  expect(repository.find('read')?.phonetic).toEqual(['/riːd/', '/rɛd/'])
  for (const value of ['/riːd/', '[riːd]', null]) {
    database.prepare('UPDATE vocabulary SET phonetic = ?').run(value)
    expect(repository.list({}).entries[0].phonetic).toEqual(value === null ? null : [value])
    expect(database.prepare('SELECT phonetic FROM vocabulary').get()).toEqual({ phonetic: value })
  }
  for (const value of ['[]', '["/riːd/", 1]', '["broken"', '[""]']) {
    database.prepare('UPDATE vocabulary SET phonetic = ?').run(value)
    expect(() => repository.list({})).toThrow('STORAGE_FAILED')
  }
})
