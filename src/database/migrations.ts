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
  },
  {
    version: 4,
    up: (database) =>
      database.exec(`
      CREATE TABLE conversation_skill_executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL UNIQUE,
        assistant_message_id TEXT,
        skill_id TEXT NOT NULL CHECK(skill_id = 'vocabulary'),
        arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json)),
        explanation_language TEXT NOT NULL CHECK(explanation_language IN ('zh-CN', 'en')),
        phase TEXT NOT NULL CHECK(phase IN (
          'started', 'analyzing', 'committing', 'summarizing', 'completed',
          'cancelled', 'failed', 'description_failed', 'description_cancelled'
        )),
        batch_json TEXT CHECK(batch_json IS NULL OR json_valid(batch_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES conversations (id),
        FOREIGN KEY (user_message_id) REFERENCES conversation_messages (id),
        FOREIGN KEY (assistant_message_id) REFERENCES conversation_messages (id)
      );
      CREATE INDEX conversation_skill_executions_session
        ON conversation_skill_executions (session_id, created_at);
    `)
  },
  {
    version: 5,
    up: (database) => {
      // 旧表的 UNIQUE(word_language, lookup_key) 与 CHECK(json_valid(analysis_json))
      // 引用了待删除字段，无法直接 DROP COLUMN，需整表重建。
      // 音标、意思、概念、例句无旧数据来源，迁移行先置 NULL，由后续写入补齐。
      database.exec(`
        CREATE TABLE vocabulary_v2 (
          id TEXT PRIMARY KEY,
          term TEXT NOT NULL,
          phonetic TEXT,
          meaning TEXT,
          concept TEXT,
          example_sentences TEXT,
          model_id TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO vocabulary_v2 (id, term, model_id, prompt_version, created_at)
        SELECT id, term, model_id, prompt_version, created_at
        FROM vocabulary
        ORDER BY rowid;
      `)

      const sourceCount = countRows(database, 'vocabulary')
      const targetCount = countRows(database, 'vocabulary_v2')
      if (targetCount !== sourceCount) {
        throw new Error(
          `Migration row count mismatch: copied ${targetCount} of ${sourceCount} vocabulary entries`
        )
      }

      database.exec(`
        DROP TABLE vocabulary;
        ALTER TABLE vocabulary_v2 RENAME TO vocabulary;
        CREATE INDEX vocabulary_created_at ON vocabulary(created_at DESC, id DESC);
      `)
    }
  },
  {
    // LLM 请求用量账本：独立于会话消息与词条事务，不设级联删除——
    // 删除业务数据不应抹除已发生的模型调用用量。
    version: 6,
    up: (database) =>
      database.exec(`
      CREATE TABLE llm_request_usage (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL CHECK (operation IN (
          'conversation', 'vocabulary_analysis', 'connection_test'
        )),
        model_id TEXT NOT NULL,
        response_model_id TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL CHECK (status IN (
          'started', 'completed', 'failed', 'cancelled', 'interrupted'
        )),
        input_tokens INTEGER CHECK (input_tokens IS NULL OR (
          typeof(input_tokens) = 'integer' AND input_tokens >= 0 AND input_tokens <= 9007199254740991
        )),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR (
          typeof(output_tokens) = 'integer' AND output_tokens >= 0 AND output_tokens <= 9007199254740991
        )),
        total_tokens INTEGER CHECK (total_tokens IS NULL OR (
          typeof(total_tokens) = 'integer' AND total_tokens >= 0 AND total_tokens <= 9007199254740991
        )),
        usage_status TEXT NOT NULL CHECK (usage_status IN (
          'reported', 'derived', 'partial', 'missing', 'invalid'
        )),
        error_code TEXT
      );
      CREATE INDEX llm_request_usage_model_started_at
        ON llm_request_usage (model_id, started_at);
    `)
  },
  {
    // 跨模型的时间范围统计按 started_at 聚合；已有 (model_id, started_at)
    // 复合索引不能服务无模型过滤的时间范围扫描。
    version: 7,
    up: (database) =>
      database.exec(`
      CREATE INDEX llm_request_usage_started_at ON llm_request_usage (started_at);
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
