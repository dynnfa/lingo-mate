import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test } from '@playwright/test'
import type { LingoMateApi } from '../../src/shared/conversation'

const SESSION_A = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const SESSION_B = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'

const V1_SCHEMA = `
  CREATE TABLE conversation_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX conversation_messages_session_created_at
    ON conversation_messages (session_id, created_at);
`

const V1_MESSAGES = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    sessionId: SESSION_A,
    role: 'user',
    content: 'Hello',
    createdAt: '2026-09-01T10:00:00.000Z'
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    sessionId: SESSION_A,
    role: 'assistant',
    content: 'Hi',
    createdAt: '2026-09-01T10:00:01.000Z'
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    sessionId: SESSION_B,
    role: 'user',
    content: 'Bonjour',
    createdAt: '2026-09-02T08:30:00.000Z'
  }
]

test('upgrades a v1 database and clears legacy conversations', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'lingo-mate-v1-upgrade-'))

  try {
    const database = new Database(join(userDataPath, 'lingo-mate.sqlite'))
    database.exec(V1_SCHEMA)
    const insert = database.prepare(
      `INSERT INTO conversation_messages (id, session_id, role, content, created_at)
       VALUES (@id, @sessionId, @role, @content, @createdAt)`
    )
    for (const message of V1_MESSAGES) {
      insert.run({
        id: message.id,
        sessionId: message.sessionId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt
      })
    }
    database.pragma('user_version = 1')
    database.close()

    const app = await electron.launch({
      args: [process.cwd(), `--user-data-dir=${userDataPath}`]
    })
    const window = await app.firstWindow()

    const upgraded = await window.evaluate(
      async ({ sessionIdA }) => {
        const api = (globalThis as typeof globalThis & { api: LingoMateApi }).api.conversation
        const listed = await api.list()
        const loadedA = await api.load({ sessionId: sessionIdA })
        return { listed, loadedA }
      },
      { sessionIdA: SESSION_A }
    )

    expect(upgraded.listed.status).toBe('ok')
    if (upgraded.listed.status === 'ok') {
      expect(upgraded.listed.conversations).toEqual([])
    }
    expect(upgraded.loadedA).toEqual({
      status: 'error',
      error: { code: 'NOT_FOUND', resource: 'conversation' }
    })
    await expect(window.locator('.message')).toHaveCount(0)

    await app.close()

    // 升级后的数据库结构达到当前 schema 版本（v8 会话标题）
    const raw = new Database(join(userDataPath, 'lingo-mate.sqlite'))
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(8)
      expect(
        (
          raw
            .prepare(
              `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_messages'`
            )
            .get() as { sql: string }
        ).sql
      ).toContain('REFERENCES conversations')
    } finally {
      raw.close()
    }
  } finally {
    await rm(userDataPath, { force: true, recursive: true })
  }
})
