import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase } from '../database'
import { migrateDatabase } from '../migrations'
import { SqliteLlmUsageRepository } from '../sqlite-llm-usage-repository'
import type { LlmUsageStart, LlmUsageTerminal } from '../../core/llm/llm-usage'

const start = (id: string, startedAt = 1_000): LlmUsageStart => ({
  id,
  operation: 'conversation',
  modelId: 'test-model',
  startedAt
})

const terminal = (source: LlmUsageStart): LlmUsageTerminal => ({
  ...source,
  status: 'completed',
  finishedAt: source.startedAt + 5,
  responseModelId: 'provider-model',
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  usageStatus: 'reported',
  errorCode: null
})

let tempDir: string
beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lingo-mate-usage-'))
})
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('llm_request_usage migrations and repository', () => {
  it('creates the table on a fresh database and upgrades an existing v5 database', () => {
    const fresh = openDatabase(':memory:')
    try {
      expect(fresh.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(6)
    } finally {
      fresh.close()
    }

    const upgraded = new Database(':memory:')
    try {
      upgraded.pragma('user_version = 5')
      expect(() => migrateDatabase(upgraded)).not.toThrow()
      expect(upgraded.pragma('user_version', { simple: true })).toBe(6)
    } finally {
      upgraded.close()
    }
  })

  it('keeps old rows when upgrading: messages and vocabulary survive, usage is queryable', () => {
    const legacy = new Database(':memory:')
    try {
      // 手工构造 v5 终态：会话消息与词条已存在、无用量表。
      legacy.exec(`
        CREATE TABLE conversations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE conversation_messages (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
          content TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE vocabulary (
          id TEXT PRIMARY KEY, term TEXT NOT NULL, phonetic TEXT, meaning TEXT,
          concept TEXT, example_sentences TEXT, model_id TEXT NOT NULL,
          prompt_version TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO conversations VALUES ('c1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO conversation_messages VALUES
          ('m1', 'c1', 'user', 'hello', '2026-01-01T00:00:00.000Z');
        INSERT INTO vocabulary VALUES
          ('v1', 'apple', NULL, NULL, NULL, NULL, 'old-model', 'vocabulary-sql-v1', '2026-01-01T00:00:00.000Z');
      `)
      legacy.pragma('user_version = 5')
      migrateDatabase(legacy)
      const messages = legacy
        .prepare('SELECT COUNT(*) AS count FROM conversation_messages')
        .get() as { count: number }
      const vocabulary = legacy.prepare('SELECT COUNT(*) AS count FROM vocabulary').get() as {
        count: number
      }
      expect(messages.count).toBe(1)
      expect(vocabulary.count).toBe(1)
    } finally {
      legacy.close()
    }
  })

  it('inserts started rows, finishes them once, and ignores late callbacks', () => {
    const database = openDatabase(':memory:')
    try {
      const repository = new SqliteLlmUsageRepository(database)
      repository.insertStarted(start('r1'))
      expect(repository.list({})).toHaveLength(1)
      expect(repository.list({})[0]).toMatchObject({
        id: 'r1',
        status: 'started',
        finishedAt: null,
        inputTokens: null,
        usageStatus: 'missing'
      })

      repository.finish(terminal(start('r1')))
      // 迟到的第二终态：既不改写既有终态，也不新增行。
      repository.finish({
        ...terminal(start('r1')),
        status: 'failed',
        errorCode: 'TIMEOUT',
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        usageStatus: 'missing'
      })
      expect(repository.list({})).toHaveLength(1)
      expect(repository.list({})[0]).toMatchObject({
        id: 'r1',
        status: 'completed',
        modelId: 'test-model',
        responseModelId: 'provider-model',
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        usageStatus: 'reported',
        finishedAt: 1_005
      })
    } finally {
      database.close()
    }
  })

  it('backfills the complete row when the started insert never landed', () => {
    const database = openDatabase(':memory:')
    try {
      const repository = new SqliteLlmUsageRepository(database)
      expect(() => repository.finish(terminal(start('r2')))).not.toThrow()
      expect(repository.list({})).toHaveLength(1)
      expect(repository.list({})[0]).toMatchObject({
        id: 'r2',
        status: 'completed',
        inputTokens: 100,
        startedAt: 1_000
      })
    } finally {
      database.close()
    }
  })

  it('marks leftover started rows as interrupted on restart without inventing finish times', () => {
    const path = join(tempDir, 'recovery.sqlite')
    const first = openDatabase(path)
    try {
      const repository = new SqliteLlmUsageRepository(first)
      repository.insertStarted(start('kept-started', 100))
      repository.insertStarted(start('already-finished', 200))
      repository.finish(terminal(start('already-finished', 200)))
    } finally {
      first.close()
    }

    // 模拟进程重启：重新打开数据库并执行启动恢复。
    const second = openDatabase(path)
    try {
      const repository = new SqliteLlmUsageRepository(second)
      expect(repository.markInterruptedStarted()).toBe(1)
      // 幂等：再次执行不再影响任何行。
      expect(repository.markInterruptedStarted()).toBe(0)
      const rows = repository.list({}).sort((a, b) => a.startedAt - b.startedAt)
      expect(rows[0]).toMatchObject({
        id: 'kept-started',
        status: 'interrupted',
        finishedAt: null,
        inputTokens: null,
        usageStatus: 'missing'
      })
      expect(rows[1]).toMatchObject({ id: 'already-finished', status: 'completed' })
    } finally {
      second.close()
    }
  })

  it('queries by model and time window with paging', () => {
    const database = openDatabase(':memory:')
    try {
      const repository = new SqliteLlmUsageRepository(database)
      const models = ['model-a', 'model-a', 'model-b']
      models.forEach((model, index) => {
        repository.insertStarted({
          id: `r${index}`,
          operation: 'conversation',
          modelId: model,
          startedAt: index + 1
        })
      })
      expect(repository.list({ modelId: 'model-a' })).toHaveLength(2)
      expect(repository.list({ modelId: 'model-b' })).toHaveLength(1)
      expect(repository.list({ fromStartedAt: 2 })).toHaveLength(2)
      expect(
        repository.list({ modelId: 'model-a', fromStartedAt: 1, toStartedAt: 1 })
      ).toHaveLength(1)
      expect(repository.list({})).toHaveLength(3)
      const page = repository.list({ limit: 2, offset: 1 })
      expect(page).toHaveLength(2)
      expect(page[0].id).toBe('r1')
      // 默认按时间倒序，可按 model+started_at 索引扫描。
      expect(repository.list({}).map((row) => row.startedAt)).toEqual([3, 2, 1])
    } finally {
      database.close()
    }
  })

  it('enforces enum and non-negative token constraints', () => {
    const database = openDatabase(':memory:')
    try {
      const insert = database.prepare(
        `INSERT INTO llm_request_usage (id, operation, model_id, started_at, status, usage_status)
         VALUES (?, ?, ?, ?, ?, 'missing')`
      )
      expect(() => insert.run('x1', 'unknown-op', 'm', 1, 'started')).toThrow()
      expect(() => insert.run('x2', 'conversation', 'm', 1, 'weird')).toThrow()
      const negative = database.prepare(
        `INSERT INTO llm_request_usage
         (id, operation, model_id, started_at, status, input_tokens, usage_status)
         VALUES ('x3', 'conversation', 'm', 1, 'started', -1, 'missing')`
      )
      expect(() => negative.run()).toThrow()
      // 安全整数上界同样受约束保护。
      insert.run('ok', 'conversation', 'm', 1, 'started')
      expect(() =>
        database
          .prepare(`UPDATE llm_request_usage SET total_tokens = 9007199254740992 WHERE id = 'ok'`)
          .run()
      ).toThrow()
    } finally {
      database.close()
    }
  })

  it.each(['inputTokens', 'outputTokens', 'totalTokens'] as const)(
    'rejects fractional %s through the repository',
    (field) => {
      const database = openDatabase(':memory:')
      try {
        const repository = new SqliteLlmUsageRepository(database)
        repository.insertStarted(start('fraction'))
        expect(() => repository.finish({ ...terminal(start('fraction')), [field]: 1.5 })).toThrow()
        expect(repository.list({})[0].status).toBe('started')
      } finally {
        database.close()
      }
    }
  )

  it('accepts explicit zero tokens as known values', () => {
    const database = openDatabase(':memory:')
    try {
      const repository = new SqliteLlmUsageRepository(database)
      repository.insertStarted(start('zero'))
      repository.finish({
        ...terminal(start('zero')),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      })
      expect(repository.list({})[0]).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        usageStatus: 'reported'
      })
    } finally {
      database.close()
    }
  })
})
