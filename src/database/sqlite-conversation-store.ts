import Database from 'better-sqlite3'
import {
  ConversationPersistenceError,
  type ConversationStore,
  type StoredMessage
} from '../core/conversation/conversation-session'

interface MessageRow {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export class SqliteConversationStore implements ConversationStore {
  private readonly database: Database.Database

  constructor(path: string) {
    this.database = new Database(path)
    this.database.pragma('journal_mode = WAL')
    this.migrate()
  }

  async append(message: StoredMessage): Promise<void> {
    try {
      this.database
        .prepare(
          `INSERT INTO conversation_messages (id, session_id, role, content, created_at)
           VALUES (@id, @sessionId, @role, @content, @createdAt)`
        )
        .run(message)
    } catch (error) {
      throw new ConversationPersistenceError('Unable to append conversation message', {
        cause: error
      })
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

      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at
      }))
    } catch (error) {
      throw new ConversationPersistenceError('Unable to load conversation history', {
        cause: error
      })
    }
  }

  close(): void {
    this.database.close()
  }

  private migrate(): void {
    const version = this.database.pragma('user_version', { simple: true }) as number

    if (version === 0) {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE conversation_messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX conversation_messages_session_created_at
            ON conversation_messages (session_id, created_at);
        `)
        this.database.pragma('user_version = 1')
      })()
      return
    }

    if (version !== 1) {
      throw new Error(`Unsupported database schema version: ${version}`)
    }
  }
}
