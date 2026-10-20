import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { MIGRATIONS, migrateDatabase } from '../migrations'
import { SqliteSynonymRepository } from '../sqlite-synonym-repository'
import type { SynonymSaveResult } from '../../core/learning/synonym/synonym-repository'
import type { SynonymBatch, SynonymListInput } from '../../shared/synonym'
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
    expect(db.pragma('user_version', { simple: true })).toBe(12)
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

describe('synonym UI list', () => {
  function seed(
    db: Database.Database,
    groups: Array<{ id: string; meaning: string; words: string[] }>
  ): void {
    const insertGroup = db.prepare('INSERT INTO synonym_group VALUES (?,?)')
    const insertWord = db.prepare(
      'INSERT INTO synonym(id, word, meaning, groupid, distinction) VALUES (?, ?, ?, ?, ?)'
    )
    for (const group of groups) {
      insertGroup.run(group.id, group.meaning)
      group.words.forEach((word, index) =>
        insertWord.run(randomUUID(), word, `${word} meaning`, group.id, `use ${index}`)
      )
    }
  }

  it('pages complete groups in id order with a probe cursor', () => {
    const { db, repository } = setup()
    const id = (suffix: string): string => `aaaaaaa${suffix}-1111-4111-8111-111111111111`
    seed(
      db,
      Array.from({ length: 7 }, (_, index) => ({
        id: id(`${index + 1}`),
        meaning: `meaning ${index}`,
        words: [`word${index}`]
      }))
    )
    const first = repository.listGroups({})
    expect(first.groups.map((group) => group.id)).toEqual([
      id('1'),
      id('2'),
      id('3'),
      id('4'),
      id('5')
    ])
    expect(first.nextCursor).toBe(id('5'))
    const second = repository.listGroups({ cursor: first.nextCursor! })
    expect(second.groups.map((group) => group.id)).toEqual([id('6'), id('7')])
    expect(second.nextCursor).toBeNull()
    // 分页以完整组为单位：两组页拼接后没有重复组。
    expect(new Set([...first.groups, ...second.groups]).size).toBe(7)
  })

  it('returns whole groups with stable word order and skips empty groups', () => {
    const { db, repository } = setup()
    const groupId = 'bbbbbbbb-1111-4111-8111-111111111111'
    seed(db, [
      { id: groupId, meaning: 'sufficient', words: ['zero', 'adequate', 'decent'] },
      { id: 'cccccccc-1111-4111-8111-111111111111', meaning: 'kept', words: ['fine'] }
    ])
    // 空组：有组无词条，不应生成伪造词条行。
    db.prepare('INSERT INTO synonym_group VALUES (?,?)').run(
      'dddddddd-1111-4111-8111-111111111111',
      'empty'
    )
    const page = repository.listGroups({})
    expect(page.groups).toHaveLength(2)
    expect(page.groups[0].words.map((entry) => entry.word)).toEqual(['adequate', 'decent', 'zero'])
    // 词条 groupid 与所属组一致，组结构完整。
    expect(page.groups[0].words.every((entry) => entry.groupid === groupId)).toBe(true)
    expect(page.groups.map((group) => group.meaning)).toEqual(['sufficient', 'kept'])
    expect(page.nextCursor).toBeNull()
  })

  it('does not merge groups that share a meaning but differ by id', () => {
    const { db, repository } = setup()
    seed(db, [
      { id: 'eeeeeeee-1111-4111-8111-111111111111', meaning: 'shared', words: ['first'] },
      { id: 'ffffffff-1111-4111-8111-111111111111', meaning: 'shared', words: ['second'] }
    ])
    const page = repository.listGroups({})
    expect(page.groups).toHaveLength(2)
    expect(new Set(page.groups.map((group) => group.id)).size).toBe(2)
  })

  it('returns oversized groups beyond the model scan budget', () => {
    const { db, repository } = setup()
    const groupId = '10101010-1111-4111-8111-111111111111'
    // 105 个词条、每条释义约 600 字符：同时超过每组 100 词与 60000 字符预算。
    seed(db, [
      {
        id: groupId,
        meaning: 'big',
        words: Array.from({ length: 105 }, (_, index) => `word${index}`)
      }
    ])
    db.prepare('UPDATE synonym SET meaning = ?, distinction = ? WHERE groupid = ?').run(
      'x'.repeat(600),
      'y'.repeat(600),
      groupId
    )
    const page = repository.listGroups({})
    expect(page.groups).toHaveLength(1)
    expect(page.groups[0].words).toHaveLength(105)
    expect(JSON.stringify(page).length).toBeGreaterThan(60000)
    // 模型工具扫描保持原有预算：同一数据仍被拦截。
    expect(() => repository.findGroups()).toThrow(/SCAN_LIMIT/)
  })

  it('rejects protocol inputs at the repository boundary', () => {
    const { repository } = setup()
    const invalid: unknown[] = [{ cursor: 'not-a-uuid' }, { extra: 1 }, { limit: 5 }]
    for (const input of invalid) {
      expect(() => repository.listGroups(input as SynonymListInput)).toThrow(/STORAGE_FAILED/)
    }
  })
})
