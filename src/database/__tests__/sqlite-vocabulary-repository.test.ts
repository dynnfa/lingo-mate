import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { MIGRATIONS, migrateDatabase } from '../migrations'
import { SqliteVocabularyRepository } from '../sqlite-vocabulary-repository'
import { stored } from '../../core/learning/vocabulary/__tests__/fixtures'

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
describe('vocabulary persistence and migrations', () => {
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
    expect(database.pragma('user_version', { simple: true })).toBe(4)
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
  it('reopens persisted analyses and uses stable keyset pagination', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vocabulary-'))
    directories.push(directory)
    const path = join(directory, 'test.sqlite')
    const first = open(path)
    const repository = new SqliteVocabularyRepository(first)
    const stamp = '2026-09-07T00:00:00.000Z'
    const entries = ['apple', 'banana', 'orange'].map((term) =>
      stored(term, { createdAt: stamp, updatedAt: stamp })
    )
    expect(repository.saveBatch(entries).every((item) => item.status === 'saved')).toBe(true)
    first.close()
    const reopened = new SqliteVocabularyRepository(open(path))
    const page1 = reopened.list({ limit: 2 })
    const page2 = reopened.list({ limit: 2, cursor: page1.nextCursor })
    expect([...page1.entries, ...page2.entries].map((item) => item.id)).toEqual(
      entries
        .map((item) => item.id)
        .sort()
        .reverse()
    )
    expect(page2.nextCursor).toBeUndefined()
    expect(reopened.find('en', 'apple')?.analysis).toEqual(entries[0].analysis)
    expect(page1.entries[0]).not.toHaveProperty('modelId')
    expect(page1.entries[0]).not.toHaveProperty('lookupKey')
  })
  it('conflicts never overwrite an existing entry, including concurrent connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vocabulary-'))
    directories.push(directory)
    const path = join(directory, 'test.sqlite')
    const repository = new SqliteVocabularyRepository(open(path))
    const concurrent = new SqliteVocabularyRepository(open(path))
    expect(repository.find('en', 'apple')).toBeUndefined()
    const entry = stored()
    concurrent.saveBatch([entry])
    expect(repository.saveBatch([stored('apple', { explanationLanguage: 'en' })])).toEqual([
      { id: entry.id, status: 'existing' }
    ])
    expect(repository.find('en', 'apple')?.explanationLanguage).toBe('zh-CN')
  })
  it('rolls back every pending insert on failure and validates analysis on write and read', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    database.exec(
      "CREATE TRIGGER fail_second BEFORE INSERT ON vocabulary WHEN NEW.term = 'bad' BEGIN SELECT RAISE(ABORT, 'fixture'); END"
    )
    expect(() => repository.saveBatch([stored('apple'), stored('bad')])).toThrow('STORAGE_FAILED')
    expect(repository.list({}).entries).toHaveLength(0)
    const invalid = stored()
    invalid.analysis.senses = []
    expect(() => repository.saveBatch([invalid])).toThrow('STORAGE_FAILED')
    repository.saveBatch([stored()])
    database.exec("UPDATE vocabulary SET analysis_json = '{}' ")
    expect(() => repository.find('en', 'apple')).toThrow('STORAGE_FAILED')
    expect(() => repository.list({})).toThrow('STORAGE_FAILED')
    expect(() => database.exec("UPDATE vocabulary SET analysis_json = 'not json'")).toThrow()
  })
  it('rejects unsupported stored analysis versions', () => {
    const database = open()
    const repository = new SqliteVocabularyRepository(database)
    repository.saveBatch([stored()])
    database.exec('UPDATE vocabulary SET analysis_schema_version = 2')
    expect(() => repository.list({})).toThrow('STORAGE_FAILED')
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

    const entry = stored('apple', { explanationLanguage: 'en' })
    const batch = repository.saveBatchWithResult(executionId, [entry], ([saved]) => ({
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

    expect(() =>
      repository.saveBatchWithResult(randomUUID(), [stored('orange')], () => batch)
    ).toThrow('STORAGE_FAILED')
    expect(repository.find('en', 'orange')).toBeUndefined()
  })
})
