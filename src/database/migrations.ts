import type Database from 'better-sqlite3'

interface Migration {
  version: number
  up: (database: Database.Database) => void
}

export const MIGRATIONS: Migration[] = [
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
  },
  {
    version: 3,
    up: (database) =>
      database.exec(`
      CREATE TABLE vocabulary (
        id TEXT PRIMARY KEY,
        term TEXT NOT NULL,
        lookup_key TEXT NOT NULL,
        word_language TEXT NOT NULL,
        explanation_language TEXT NOT NULL,
        analysis_json TEXT NOT NULL CHECK(json_valid(analysis_json)),
        analysis_schema_version INTEGER NOT NULL,
        analysis_source TEXT NOT NULL,
        model_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(word_language, lookup_key)
      );
      CREATE INDEX vocabulary_created_at ON vocabulary(created_at DESC, id DESC);
    `)
  }
]

export function migrateDatabase(database: Database.Database): void {
  const version = database.pragma('user_version', { simple: true }) as number
  if (version > MIGRATIONS[MIGRATIONS.length - 1].version) {
    throw new Error(`Unsupported database schema version: ${version}`)
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue
    database.transaction(() => {
      migration.up(database)
      database.pragma(`user_version = ${migration.version}`)
    })()
  }
}

function countRows(database: Database.Database, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count
}
