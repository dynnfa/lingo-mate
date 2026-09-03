import Database from 'better-sqlite3'
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

interface Migration {
  version: number
  up: (database: Database.Database) => void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (database) => {
      database.exec(`
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
    }
  },
  {
    version: 2,
    up: (database) => {
      database.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX conversations_updated_at
          ON conversations (updated_at DESC, created_at DESC);
      `)

      // 回填会话：created_at 取最早消息时间，updated_at 取最晚消息时间。
      database.exec(`
        INSERT INTO conversations (id, created_at, updated_at)
        SELECT session_id, MIN(created_at), MAX(created_at)
        FROM conversation_messages
        GROUP BY session_id;
      `)

      database.exec(`
        CREATE TABLE conversation_messages_v2 (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (session_id) REFERENCES conversations (id)
        );
        INSERT INTO conversation_messages_v2 (id, session_id, role, content, created_at)
        SELECT id, session_id, role, content, created_at
        FROM conversation_messages
        ORDER BY rowid;
      `)

      const sourceCount = countRows(database, 'conversation_messages')
      const targetCount = countRows(database, 'conversation_messages_v2')
      if (targetCount !== sourceCount) {
        throw new Error(
          `Migration row count mismatch: copied ${targetCount} of ${sourceCount} messages`
        )
      }
      const foreignKeyViolations = database.pragma('foreign_key_check') as unknown[]
      if (foreignKeyViolations.length > 0) {
        throw new Error(`Migration foreign key check failed: ${foreignKeyViolations.length} rows`)
      }

      database.exec(`
        DROP TABLE conversation_messages;
        ALTER TABLE conversation_messages_v2 RENAME TO conversation_messages;
        CREATE INDEX conversation_messages_session_created_at
          ON conversation_messages (session_id, created_at);
      `)
    }
  }
]

const LATEST_SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1].version

export class SqliteConversationRepository implements ConversationRepository {
  private readonly database: Database.Database

  constructor(path: string) {
    this.database = new Database(path)
    this.database.pragma('journal_mode = WAL')
    // foreign_keys 是连接级开关，必须在迁移事务之外启用。
    this.database.pragma('foreign_keys = ON')
    this.migrate()
  }

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

  close(): void {
    this.database.close()
  }

  private migrate(): void {
    const version = this.database.pragma('user_version', { simple: true }) as number

    if (version > LATEST_SCHEMA_VERSION) {
      throw new Error(`Unsupported database schema version: ${version}`)
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue
      this.database.transaction(() => {
        migration.up(this.database)
        this.database.pragma(`user_version = ${migration.version}`)
      })()
    }
  }
}

function countRows(database: Database.Database, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count
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
