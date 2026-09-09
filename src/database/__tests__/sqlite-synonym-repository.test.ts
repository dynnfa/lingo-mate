import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { MIGRATIONS, migrateDatabase } from '../migrations'
import { SqliteSynonymRepository } from '../sqlite-synonym-repository'
import type { SynonymSaveResult } from '../../core/learning/synonym/synonym-repository'
import type { SynonymBatch } from '../../shared/synonym'
const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function setup(): { db: Database.Database; id: string; repository: SqliteSynonymRepository } {
  const db = openDatabase(':memory:')
  databases.push(db)
  const id = randomUUID()
  db.exec(
    `INSERT INTO conversations VALUES ('s','now','now','test'); INSERT INTO conversation_messages VALUES ('m','s','user','test','now')`
  )
  db.prepare(
    `INSERT INTO conversation_skill_executions(id,session_id,user_message_id,skill_id,arguments_json,explanation_language,phase,created_at,updated_at) VALUES (?,'s','m','synonym','{}','en','analyzing','now','now')`
  ).run(id)
  return { db, id, repository: new SqliteSynonymRepository(db) }
}
const content = {
  word: 'adequate',
  meaning: 'acceptable',
  distinction: 'minimum standard',
  groupMeaning: 'acceptable'
}
const report = (result: SynonymSaveResult): SynonymBatch => ({
  requestId: randomUUID(),
  explanationLanguage: 'en',
  outcome: 'completed',
  items: [{ inputIndex: 0, input: 'adequate', word: 'adequate', ...result }]
})
describe('synonym persistence', () => {
  it('upgrades v9, preserves old executions and usage, and is idempotent', () => {
    const db = new Database(':memory:')
    databases.push(db)
    db.pragma('foreign_keys=ON')
    for (const migration of MIGRATIONS.filter((item) => item.version <= 9)) migration.up(db)
    db.pragma('user_version=9')
    db.exec(`INSERT INTO conversations VALUES ('s','now','now','test'); INSERT INTO conversation_messages VALUES ('m','s','user','test','now');
      INSERT INTO conversation_skill_executions(id,session_id,user_message_id,skill_id,arguments_json,explanation_language,phase,created_at,updated_at) VALUES ('e','s','m','phrase','{}','en','completed','now','now');
      INSERT INTO llm_request_usage(id,operation,model_id,started_at,status,usage_status) VALUES ('u','phrase_analysis','model',1,'completed','missing');`)
    const executions = db.prepare('SELECT * FROM conversation_skill_executions').all()
    const usage = db.prepare('SELECT * FROM llm_request_usage').all()
    migrateDatabase(db)
    migrateDatabase(db)
    expect(db.prepare('SELECT * FROM conversation_skill_executions').all()).toEqual(executions)
    expect(db.prepare('SELECT * FROM llm_request_usage').all()).toEqual(usage)
    expect(db.pragma('user_version', { simple: true })).toBe(10)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(() =>
      db.exec(
        `INSERT INTO llm_request_usage(id,operation,model_id,started_at,status,usage_status) VALUES ('u2','synonym_analysis','model',1,'completed','missing')`
      )
    ).not.toThrow()
  })
  it('commits entry and report together and replays without creating empty groups', () => {
    const { db, id, repository } = setup()
    const first = repository.saveWord(id, content, report)
    const second = repository.saveWord(id, content, report)
    expect(first.status).toBe('saved')
    expect(second.status).toBe('existing')
    expect(first.entry).toEqual(second.entry)
    expect(db.prepare('SELECT * FROM synonym_group').all()).toHaveLength(1)
    expect(db.prepare('SELECT * FROM synonym').all()).toHaveLength(1)
    expect(() =>
      db
        .prepare('INSERT INTO synonym VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), 'adequate', 'other', first.entry.groupid, 'other')
    ).toThrow()
    expect(() =>
      db
        .prepare('INSERT INTO synonym VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), 'new', 'other', randomUUID(), 'other')
    ).toThrow()
  })
  it.each(['entry', 'report'])('rolls back a new group if %s persistence fails', (failure) => {
    const { db, id, repository } = setup()
    if (failure === 'entry')
      db.exec(
        `CREATE TRIGGER reject_word BEFORE INSERT ON synonym BEGIN SELECT RAISE(ABORT, 'injected'); END`
      )
    else
      db.exec(
        `CREATE TRIGGER reject_report BEFORE UPDATE OF batch_json ON conversation_skill_executions BEGIN SELECT RAISE(ABORT, 'injected'); END`
      )
    expect(() => repository.saveWord(id, content, report)).toThrow(/STORAGE_FAILED/)
    expect(db.prepare('SELECT * FROM synonym_group').all()).toEqual([])
    expect(db.prepare('SELECT * FROM synonym').all()).toEqual([])
  })
  it('rolls back additions to an existing group if report persistence fails', () => {
    const { db, id, repository } = setup()
    const first = repository.saveWord(id, content, report)
    expect(() =>
      repository.saveWord(
        'missing',
        { word: 'decent', meaning: 'okay', distinction: 'informal', groupid: first.entry.groupid },
        (result) => ({ ...report(result), items: [{ ...report(result).items[0], word: 'decent' }] })
      )
    ).toThrow()
    expect(db.prepare('SELECT word FROM synonym').all()).toEqual([{ word: 'adequate' }])
  })
  it('pages all groups and bounds oversized group responses', () => {
    const { db, repository } = setup()
    for (let index = 0; index < 7; index++)
      db.prepare('INSERT INTO synonym_group VALUES (?,?)').run(randomUUID(), `meaning ${index}`)
    const first = repository.findGroups()
    expect(first.groups).toHaveLength(5)
    const second = repository.findGroups(first.nextCursor!)
    expect(second.groups).toHaveLength(2)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.groups, ...second.groups].map((g) => g.id)).size).toBe(7)
  })
})
