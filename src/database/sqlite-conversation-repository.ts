import type Database from 'better-sqlite3'
import {
  ConversationPersistenceError,
  type ConversationRepository,
  type StoredConversation,
  type StoredMessage
} from '../core/conversation/conversation-repository'

interface ConversationRow {
  id: string
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly database: Database.Database) {}

  async create(conversation: StoredConversation): Promise<void> {
    try {
      this.database
        .prepare(
          `INSERT INTO conversations (id, created_at, updated_at)
           VALUES (@id, @createdAt, @updatedAt)`
        )
        .run(conversation)
    } catch (error) {
      throw new ConversationPersistenceError('Unable to create conversation', { cause: error })
    }
  }

  async list(): Promise<StoredConversation[]> {
    try {
      const rows = this.database
        .prepare(
          `SELECT id, created_at, updated_at
           FROM conversations
           ORDER BY updated_at DESC, created_at DESC`
        )
        .all() as ConversationRow[]

      return rows.map(toStoredConversation)
    } catch (error) {
      throw new ConversationPersistenceError('Unable to list conversations', { cause: error })
    }
  }

  async find(sessionId: string): Promise<StoredConversation | undefined> {
    try {
      const row = this.database
        .prepare('SELECT id, created_at, updated_at FROM conversations WHERE id = ?')
        .get(sessionId) as ConversationRow | undefined

      return row ? toStoredConversation(row) : undefined
    } catch (error) {
      throw new ConversationPersistenceError('Unable to find conversation', { cause: error })
    }
  }

  async history(sessionId: string): Promise<StoredMessage[]> {
    try {
      const rows = this.database
        .prepare(
          `SELECT id, session_id, role, content, created_at
           FROM conversation_messages
           WHERE session_id = ?
           ORDER BY created_at ASC, rowid ASC`
        )
        .all(sessionId) as MessageRow[]

      return rows.map(toStoredMessage)
    } catch (error) {
      throw new ConversationPersistenceError('Unable to load conversation history', {
        cause: error
      })
    }
  }

  async appendMessage(message: StoredMessage): Promise<void> {
    try {
      // 插入消息与更新会话 updated_at 必须同事务，保证列表排序不依赖额外 touch。
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO conversation_messages (id, session_id, role, content, created_at)
             VALUES (@id, @sessionId, @role, @content, @createdAt)`
          )
          .run(message)
        this.database
          .prepare('UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?')
          .run(message.createdAt, message.sessionId)
      })()
    } catch (error) {
      throw new ConversationPersistenceError('Unable to append conversation message', {
        cause: error
      })
    }
  }
}

function toStoredConversation(row: ConversationRow): StoredConversation {
  return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at }
}

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at
  }
}
