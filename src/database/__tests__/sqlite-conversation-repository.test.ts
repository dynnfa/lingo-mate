import { openDatabase } from '../database'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  ConversationPersistenceError,
  type StoredConversation,
  type StoredMessage
} from '../../core/conversation/conversation-repository'
import { SqliteConversationRepository } from '../sqlite-conversation-repository'

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

const SESSION_A = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const SESSION_B = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'

interface V1Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

let workspace: string
let databases: Database.Database[]

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'lingo-mate-sqlite-'))
  databases = []
})

afterEach(async () => {
  for (const database of databases) database.close()
  await rm(workspace, { force: true, recursive: true })
})

function databasePath(name = 'conversations.sqlite'): string {
  return join(workspace, name)
}

function openRepository(path = databasePath()): SqliteConversationRepository {
  const database = openDatabase(path)
  databases.push(database)
  const repository = new SqliteConversationRepository(database)
  return repository
}

function createV1Database(
  path: string,
  messages: V1Message[],
  extraSetup?: (database: Database.Database) => void
): void {
  const database = new Database(path)
  database.exec(V1_SCHEMA)
  const insert = database.prepare(
    `INSERT INTO conversation_messages (id, session_id, role, content, created_at)
     VALUES (@id, @sessionId, @role, @content, @createdAt)`
  )
  for (const message of messages) {
    insert.run({
      id: message.id,
      sessionId: message.sessionId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt
    })
  }
  extraSetup?.(database)
  database.pragma('user_version = 1')
  database.close()
}

function storedConversation(id: string, createdAt: string, updatedAt: string): StoredConversation {
  return { id, createdAt, updatedAt }
}

function storedMessage(
  id: string,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt: string
): StoredMessage {
  return { id, sessionId, role, content, createdAt }
}

describe('SqliteConversationRepository', () => {
  it('creates the latest schema for a fresh database', () => {
    const path = databasePath()
    const repository = openRepository(path)

    const conversation = storedConversation(
      SESSION_A,
      '2026-09-01T10:00:00.000Z',
      '2026-09-01T10:00:00.000Z'
    )
    void repository.create(conversation)

    const raw = new Database(path)
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(6)
      expect(
        raw
          .prepare(
            `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_messages'`
          )
          .get()
      ).toMatchObject({ sql: expect.stringContaining('REFERENCES conversations') })
    } finally {
      raw.close()
    }
  })

  it('backfills conversations and preserves history when upgrading a v1 database', async () => {
    const path = databasePath()
    createV1Database(path, [
      {
        id: 'a1',
        sessionId: SESSION_A,
        role: 'user',
        content: 'Hello',
        createdAt: '2026-09-01T10:00:00.000Z'
      },
      {
        id: 'a2',
        sessionId: SESSION_A,
        role: 'assistant',
        content: 'Hi',
        createdAt: '2026-09-01T10:00:01.000Z'
      },
      {
        id: 'b1',
        sessionId: SESSION_B,
        role: 'user',
        content: 'Bonjour',
        createdAt: '2026-09-02T08:30:00.000Z'
      }
    ])

    const repository = openRepository(path)

    expect(await repository.list()).toEqual([
      storedConversation(SESSION_B, '2026-09-02T08:30:00.000Z', '2026-09-02T08:30:00.000Z'),
      storedConversation(SESSION_A, '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:01.000Z')
    ])
    expect(await repository.history(SESSION_A)).toEqual([
      storedMessage('a1', SESSION_A, 'user', 'Hello', '2026-09-01T10:00:00.000Z'),
      storedMessage('a2', SESSION_A, 'assistant', 'Hi', '2026-09-01T10:00:01.000Z')
    ])
  })

  it('enforces the foreign key when appending to an unknown conversation', async () => {
    const repository = openRepository()

    await expect(
      repository.appendMessage(
        storedMessage('m1', SESSION_A, 'user', 'Hello', '2026-09-01T10:00:00.000Z')
      )
    ).rejects.toThrow(ConversationPersistenceError)
  })

  it('updates updatedAt and keeps ordering stable when appending messages', async () => {
    const repository = openRepository()
    await repository.create(
      storedConversation(SESSION_A, '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z')
    )
    await repository.create(
      storedConversation(SESSION_B, '2026-09-02T08:30:00.000Z', '2026-09-02T08:30:00.000Z')
    )

    expect((await repository.list()).map((conversation) => conversation.id)).toEqual([
      SESSION_B,
      SESSION_A
    ])

    await repository.appendMessage(
      storedMessage('m1', SESSION_A, 'user', 'Hello', '2026-09-03T09:00:00.000Z')
    )

    const conversation = await repository.find(SESSION_A)
    expect(conversation?.updatedAt).toBe('2026-09-03T09:00:00.000Z')
    expect((await repository.list()).map((item) => item.id)).toEqual([SESSION_A, SESSION_B])
  })

  it('rolls back a failed append so no partial state is written', async () => {
    const path = databasePath()
    const repository = openRepository(path)
    await repository.create(
      storedConversation(SESSION_A, '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z')
    )

    // 通过触发器让事务中的第二条语句（updatedAt touch）失败，验证整体回滚。
    const controlConnection = new Database(path)
    try {
      controlConnection.exec(
        `CREATE TRIGGER fail_conversation_touch
         BEFORE UPDATE ON conversations
         BEGIN
           SELECT RAISE(ABORT, 'forced touch failure');
         END`
      )

      await expect(
        repository.appendMessage(
          storedMessage('m1', SESSION_A, 'user', 'Hello', '2026-09-03T09:00:00.000Z')
        )
      ).rejects.toThrow(ConversationPersistenceError)

      expect(await repository.history(SESSION_A)).toEqual([])
      expect((await repository.find(SESSION_A))?.updatedAt).toBe('2026-09-01T10:00:00.000Z')
    } finally {
      controlConnection.close()
    }
  })

  it('rolls back the migration transaction when it fails mid-way', () => {
    const path = databasePath()
    createV1Database(
      path,
      [
        {
          id: 'a1',
          sessionId: SESSION_A,
          role: 'user',
          content: 'Hello',
          createdAt: '2026-09-01T10:00:00.000Z'
        }
      ],
      (database) => {
        // 占用 conversations 表名，使 v2 迁移在创建表时失败。
        database.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY)')
      }
    )

    expect(() => openRepository(path)).toThrow(/conversations/)

    const raw = new Database(path)
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(1)
      expect(
        (
          raw.prepare('SELECT COUNT(*) AS count FROM conversation_messages').get() as {
            count: number
          }
        ).count
      ).toBe(1)
    } finally {
      raw.close()
    }
  })

  it('rejects databases from a newer schema version', () => {
    const path = databasePath()
    const raw = new Database(path)
    raw.pragma('user_version = 7')
    raw.close()

    expect(() => openRepository(path)).toThrow('Unsupported database schema version: 7')
  })
})
