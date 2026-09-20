import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { MIGRATIONS, migrateDatabase } from '../migrations'
import { SqliteVocabularyMistakeRepository } from '../sqlite-vocabulary-mistake-repository'
import type { VocabularyMistakeRecord } from '../../core/learning/vocabulary-practice/vocabulary-mistake-repository'

const ENTRY_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const ENTRY_B = 'aaaaaaaa-0000-4000-8000-000000000002'
const ENTRY_C = 'aaaaaaaa-0000-4000-8000-000000000003'
const REVIEW_1 = 'bbbbbbbb-0000-4000-8000-000000000001'
const REVIEW_2 = 'bbbbbbbb-0000-4000-8000-000000000002'

const databases: Database.Database[] = []
function open(path = ':memory:'): Database.Database {
  const database = openDatabase(path)
  databases.push(database)
  return database
}

let recordSeq = 0
function record(overrides: Partial<VocabularyMistakeRecord> = {}): VocabularyMistakeRecord {
  recordSeq += 1
  return {
    id: `cccccccc-0000-4000-8000-${String(recordSeq).padStart(12, '0')}`,
    reviewId: REVIEW_1,
    entryId: ENTRY_A,
    term: 'apple',
    submittedMeaning: '一种水果',
    createdAt: '2026-09-20T10:00:00.000Z',
    ...overrides
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
})

describe('vocabulary mistake migrations', () => {
  it('creates the mistakes table on a fresh database and is idempotent', () => {
    const database = open()
    migrateDatabase(database)
    migrateDatabase(database)
    expect(database.pragma('user_version', { simple: true })).toBe(11)
    const columns = (
      database.pragma('table_info(vocabulary_practice_mistakes)') as Array<{
        name: string
      }>
    ).map((column) => column.name)
    expect(columns).toEqual([
      'id',
      'review_id',
      'entry_id',
      'term',
      'submitted_meaning',
      'created_at'
    ])
  })

  it('upgrades a v10 database without touching existing vocabulary rows', () => {
    const database = new Database(':memory:')
    databases.push(database)
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 10))
      migration.up(database)
    database.pragma('user_version = 10')
    const stamp = '2026-09-01T00:00:00.000Z'
    database.exec(`
      INSERT INTO vocabulary (id, term, phonetic, meaning, concept, example_sentences, model_id, prompt_version, created_at)
      VALUES ('v1', 'apple', NULL, 'fruit', NULL, NULL, 'm', 'p', '${stamp}');
    `)
    migrateDatabase(database)
    expect(database.prepare('SELECT term FROM vocabulary').get()).toEqual({ term: 'apple' })
    expect(database.pragma('user_version', { simple: true })).toBe(11)
    expect(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND tbl_name = 'vocabulary_practice_mistakes'"
          )
          .get() as { count: number }
      ).count
    ).toBeGreaterThanOrEqual(2)
  })

  it('enforces the unique review/entry pair and content constraints', () => {
    const database = open()
    migrateDatabase(database)
    const insert = (id: string, reviewId: string, entryId: string, meaning: string): void => {
      database
        .prepare(
          `INSERT INTO vocabulary_practice_mistakes
           (id, review_id, entry_id, term, submitted_meaning, created_at)
           VALUES (?, ?, ?, 'apple', ?, '2026-09-20T10:00:00.000Z')`
        )
        .run(id, reviewId, entryId, meaning)
    }
    insert('cccccccc-0000-4000-8000-000000000001', REVIEW_1, ENTRY_A, '一种水果')
    // 同一次审查同一词条：唯一约束拒绝重复
    expect(() =>
      insert('cccccccc-0000-4000-8000-000000000002', REVIEW_1, ENTRY_A, '另一种')
    ).toThrow()
    // 不同审查或不同词条允许
    insert('cccccccc-0000-4000-8000-000000000003', REVIEW_2, ENTRY_A, '再一种')
    insert('cccccccc-0000-4000-8000-000000000004', REVIEW_1, ENTRY_B, '另一种水果')
    // 空白与超长内容由 CHECK 拒绝
    expect(() =>
      database
        .prepare(
          `INSERT INTO vocabulary_practice_mistakes
           (id, review_id, entry_id, term, submitted_meaning, created_at)
           VALUES ('cccccccc-0000-4000-8000-000000000005', ?, ?, 'apple', '  ', '2026-09-20T10:00:00.000Z')`
        )
        .run(randomUUID(), ENTRY_C)
    ).toThrow()
    expect(() =>
      database
        .prepare(
          `INSERT INTO vocabulary_practice_mistakes
           (id, review_id, entry_id, term, submitted_meaning, created_at)
           VALUES ('cccccccc-0000-4000-8000-000000000006', ?, ?, '  ', '答案', '2026-09-20T10:00:00.000Z')`
        )
        .run(randomUUID(), ENTRY_C)
    ).toThrow()
  })
})

describe('vocabulary mistake repository saveBatch', () => {
  it('saves a whole review atomically and replays idempotently', () => {
    const database = open()
    const repository = new SqliteVocabularyMistakeRepository(database)
    const batch = [
      record({ entryId: ENTRY_A, submittedMeaning: '错误一' }),
      record({ entryId: ENTRY_B, term: 'banana', submittedMeaning: '错误二' })
    ]
    repository.saveBatch(batch)
    // 重放同一次提交（重复 IPC / 保存重试）：不重复计数
    repository.saveBatch(batch)
    expect(
      (
        database.prepare('SELECT COUNT(*) AS count FROM vocabulary_practice_mistakes').get() as {
          count: number
        }
      ).count
    ).toBe(2)
  })

  it('rolls back the whole batch when any record is invalid', () => {
    const database = open()
    const repository = new SqliteVocabularyMistakeRepository(database)
    expect(() =>
      repository.saveBatch([
        record({ entryId: ENTRY_A }),
        record({ entryId: ENTRY_B, submittedMeaning: '   ' })
      ])
    ).toThrow('STORAGE_FAILED')
    expect(
      (
        database.prepare('SELECT COUNT(*) AS count FROM vocabulary_practice_mistakes').get() as {
          count: number
        }
      ).count
    ).toBe(0)
    // 非法 UUID 与非法时间同样拒绝
    expect(() => repository.saveBatch([record({ entryId: 'not-a-uuid' })])).toThrow(
      'STORAGE_FAILED'
    )
    expect(() => repository.saveBatch([record({ createdAt: '2026-09-20 10:00:00' })])).toThrow(
      'STORAGE_FAILED'
    )
  })

  it('treats empty batches as a no-op', () => {
    const database = open()
    const repository = new SqliteVocabularyMistakeRepository(database)
    repository.saveBatch([])
    expect(
      (
        database.prepare('SELECT COUNT(*) AS count FROM vocabulary_practice_mistakes').get() as {
          count: number
        }
      ).count
    ).toBe(0)
  })
})

describe('vocabulary mistake repository list', () => {
  it('aggregates one row per entry with the latest meaning and total count', () => {
    const database = open()
    const repository = new SqliteVocabularyMistakeRepository(database)
    repository.saveBatch([
      record({
        reviewId: REVIEW_1,
        entryId: ENTRY_A,
        term: 'apple',
        submittedMeaning: '第一次错',
        createdAt: '2026-09-20T10:00:00.000Z'
      }),
      record({
        reviewId: REVIEW_1,
        entryId: ENTRY_B,
        term: 'banana',
        submittedMeaning: '香蕉错',
        createdAt: '2026-09-20T09:00:00.000Z'
      })
    ])
    repository.saveBatch([
      record({
        reviewId: REVIEW_2,
        entryId: ENTRY_A,
        term: 'apple',
        submittedMeaning: '第二次错',
        createdAt: '2026-09-20T11:00:00.000Z'
      })
    ])

    const page = repository.list({})
    expect(page.entries).toEqual([
      {
        entryId: ENTRY_A,
        term: 'apple',
        lastSubmittedMeaning: '第二次错',
        totalMistakes: 2,
        lastErrorAt: '2026-09-20T11:00:00.000Z'
      },
      {
        entryId: ENTRY_B,
        term: 'banana',
        lastSubmittedMeaning: '香蕉错',
        totalMistakes: 1,
        lastErrorAt: '2026-09-20T09:00:00.000Z'
      }
    ])
    expect(page.nextCursor).toBeUndefined()
  })

  it('breaks latest-record ties deterministically and pages without overlap or gap', () => {
    const database = open()
    const repository = new SqliteVocabularyMistakeRepository(database)
    const stamp = '2026-09-20T10:00:00.000Z'
    // 三个词条同一时间出错：排序由 entryId DESC 稳定决定
    repository.saveBatch([
      record({ reviewId: REVIEW_1, entryId: ENTRY_A, submittedMeaning: 'A', createdAt: stamp }),
      record({ reviewId: REVIEW_1, entryId: ENTRY_B, submittedMeaning: 'B', createdAt: stamp }),
      record({
        reviewId: REVIEW_1,
        entryId: ENTRY_C,
        term: 'cherry',
        submittedMeaning: 'C',
        createdAt: stamp
      })
    ])

    const first = repository.list({ limit: 2 })
    expect(first.entries.map((entry) => entry.entryId)).toEqual([ENTRY_C, ENTRY_B])
    expect(first.nextCursor).toEqual({ lastErrorAt: stamp, entryId: ENTRY_B })

    const second = repository.list({ limit: 2, cursor: first.nextCursor })
    expect(second.entries.map((entry) => entry.entryId)).toEqual([ENTRY_A])
    expect(second.nextCursor).toBeUndefined()
  })

  it('keeps history after a later review answers correctly for another entry', () => {
    const database = open()
    const repository = new SqliteVocabularyMistakeRepository(database)
    repository.saveBatch([
      record({
        reviewId: REVIEW_1,
        entryId: ENTRY_A,
        submittedMeaning: '错',
        createdAt: '2026-09-20T10:00:00.000Z'
      })
    ])
    // 后来答对不删除历史：仓储没有删除入口，历史仍可查
    const history = repository.listHistory({ entryId: ENTRY_A })
    expect(history.items).toHaveLength(1)
  })
})

describe('vocabulary mistake repository listHistory', () => {
  it('pages one entry history in reverse time order and isolates entries', () => {
    const database = open()
    const repository = new SqliteVocabularyMistakeRepository(database)
    const at = (minute: number): string =>
      `2026-09-20T10:${String(minute).padStart(2, '0')}:00.000Z`
    repository.saveBatch([
      record({
        reviewId: REVIEW_1,
        entryId: ENTRY_A,
        submittedMeaning: '第一次',
        createdAt: at(0)
      }),
      record({
        reviewId: REVIEW_1,
        entryId: ENTRY_B,
        term: 'banana',
        submittedMeaning: '别的词',
        createdAt: at(5)
      }),
      record({
        reviewId: REVIEW_2,
        entryId: ENTRY_A,
        submittedMeaning: '第二次',
        createdAt: at(10)
      }),
      record({
        reviewId: randomUUID(),
        entryId: ENTRY_A,
        submittedMeaning: '第三次',
        createdAt: at(20)
      })
    ])

    const first = repository.listHistory({ entryId: ENTRY_A, limit: 2 })
    expect(first.items.map((item) => item.submittedMeaning)).toEqual(['第三次', '第二次'])
    expect(first.nextCursor).toBeDefined()

    const second = repository.listHistory({
      entryId: ENTRY_A,
      limit: 2,
      cursor: first.nextCursor
    })
    expect(second.items.map((item) => item.submittedMeaning)).toEqual(['第一次'])
    expect(second.nextCursor).toBeUndefined()

    // 其他词条的历史不混入
    const other = repository.listHistory({ entryId: ENTRY_B })
    expect(other.items.map((item) => item.submittedMeaning)).toEqual(['别的词'])
  })

  it('rejects malformed inputs', () => {
    const database = open()
    const repository = new SqliteVocabularyMistakeRepository(database)
    expect(() => repository.list({ limit: 0 })).toThrow('STORAGE_FAILED')
    expect(() => repository.list({ cursor: { lastErrorAt: 'nope', entryId: ENTRY_A } })).toThrow(
      'STORAGE_FAILED'
    )
    expect(() => repository.listHistory({ entryId: 'not-a-uuid' })).toThrow('STORAGE_FAILED')
  })
})

describe('vocabulary mistake repository storage failures', () => {
  it('wraps save and query failures as STORAGE_FAILED', () => {
    const database = open()
    const repository = new SqliteVocabularyMistakeRepository(database)
    database.exec('DROP TABLE vocabulary_practice_mistakes')
    expect(() => repository.saveBatch([record()])).toThrow('STORAGE_FAILED')
    expect(() => repository.list({})).toThrow('STORAGE_FAILED')
    expect(() => repository.listHistory({ entryId: ENTRY_A })).toThrow('STORAGE_FAILED')
  })
})
