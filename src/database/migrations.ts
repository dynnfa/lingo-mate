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
  },
  {
    version: 8,
    // 用户确认清空旧会话；按外键依赖顺序删除，不影响词库和用量账本。
    up: (database) =>
      database.exec(`
      DELETE FROM conversation_skill_executions;
      DELETE FROM conversation_messages;
      DELETE FROM conversations;
      ALTER TABLE conversations ADD COLUMN title TEXT NOT NULL
        CHECK (length(trim(title)) BETWEEN 1 AND 80);
    `)
  },
  {
    // /phrase 短语收录：新表 + 放宽技能 ID 与用量 operation 的 CHECK 约束。
    // 列级 CHECK 无法直接修改，两张含约束的表需整表重建并保留全部历史行。
    version: 9,
    up: (database) => {
      // 短语表只有需求指定的三列；空白与超长由 CHECK 拒绝，主键按大小写敏感比较。
      database.exec(`
        CREATE TABLE phrase (
          phrase TEXT PRIMARY KEY NOT NULL CHECK (
            typeof(phrase) = 'text'
            AND length(phrase) <= 200
            AND length(trim(phrase)) BETWEEN 1 AND 200
          ),
          explantation TEXT NOT NULL CHECK (
            typeof(explantation) = 'text'
            AND length(explantation) <= 2000
            AND length(trim(explantation)) BETWEEN 1 AND 2000
          ),
          example TEXT NOT NULL CHECK (
            typeof(example) = 'text'
            AND length(example) <= 1000
            AND length(trim(example)) BETWEEN 1 AND 1000
          )
        );
      `)

      database.exec(`
        CREATE TABLE conversation_skill_executions_v9 (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          user_message_id TEXT NOT NULL UNIQUE,
          assistant_message_id TEXT,
          skill_id TEXT NOT NULL CHECK(skill_id IN ('vocabulary', 'phrase')),
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
        INSERT INTO conversation_skill_executions_v9
          (id, session_id, user_message_id, assistant_message_id, skill_id, arguments_json,
           explanation_language, phase, batch_json, created_at, updated_at)
        SELECT id, session_id, user_message_id, assistant_message_id, skill_id, arguments_json,
               explanation_language, phase, batch_json, created_at, updated_at
        FROM conversation_skill_executions
        ORDER BY rowid;
      `)
      copyCountCheck(database, 'conversation_skill_executions', 'conversation_skill_executions_v9')
      database.exec(`
        DROP TABLE conversation_skill_executions;
        ALTER TABLE conversation_skill_executions_v9 RENAME TO conversation_skill_executions;
        CREATE INDEX conversation_skill_executions_session
          ON conversation_skill_executions (session_id, created_at);
      `)

      database.exec(`
        CREATE TABLE llm_request_usage_v9 (
          id TEXT PRIMARY KEY,
          operation TEXT NOT NULL CHECK (operation IN (
            'conversation', 'vocabulary_analysis', 'phrase_analysis', 'connection_test'
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
        INSERT INTO llm_request_usage_v9
          SELECT * FROM llm_request_usage ORDER BY rowid;
      `)
      copyCountCheck(database, 'llm_request_usage', 'llm_request_usage_v9')
      database.exec(`
        DROP TABLE llm_request_usage;
        ALTER TABLE llm_request_usage_v9 RENAME TO llm_request_usage;
        CREATE INDEX llm_request_usage_model_started_at
          ON llm_request_usage (model_id, started_at);
        CREATE INDEX llm_request_usage_started_at ON llm_request_usage (started_at);
      `)
    }
  },
  {
    version: 10,
    up: (database) => {
      database.exec(`
        CREATE TABLE synonym_group (
          id TEXT PRIMARY KEY NOT NULL,
          meaning TEXT NOT NULL CHECK(length(trim(meaning)) BETWEEN 1 AND 2000)
        );
        CREATE TABLE synonym (
          id TEXT PRIMARY KEY NOT NULL,
          word TEXT NOT NULL UNIQUE CHECK(length(trim(word)) BETWEEN 1 AND 100),
          meaning TEXT NOT NULL CHECK(length(trim(meaning)) BETWEEN 1 AND 2000),
          groupid TEXT NOT NULL REFERENCES synonym_group(id),
          distinction TEXT NOT NULL CHECK(length(trim(distinction)) BETWEEN 1 AND 2000)
        );
        CREATE INDEX synonym_groupid ON synonym(groupid);
      `)
      database.exec(`
        CREATE TABLE conversation_skill_executions_v10 (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          user_message_id TEXT NOT NULL UNIQUE,
          assistant_message_id TEXT,
          skill_id TEXT NOT NULL CHECK(skill_id IN ('vocabulary', 'phrase', 'synonym')),
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
        INSERT INTO conversation_skill_executions_v10
          (id, session_id, user_message_id, assistant_message_id, skill_id, arguments_json,
           explanation_language, phase, batch_json, created_at, updated_at)
        SELECT id, session_id, user_message_id, assistant_message_id, skill_id, arguments_json,
               explanation_language, phase, batch_json, created_at, updated_at
        FROM conversation_skill_executions
        ORDER BY rowid;
      `)
      copyCountCheck(database, 'conversation_skill_executions', 'conversation_skill_executions_v10')
      database.exec(`
        DROP TABLE conversation_skill_executions;
        ALTER TABLE conversation_skill_executions_v10 RENAME TO conversation_skill_executions;
        CREATE INDEX conversation_skill_executions_session
          ON conversation_skill_executions (session_id, created_at);
      `)

      database.exec(`
        CREATE TABLE llm_request_usage_v10 (
          id TEXT PRIMARY KEY,
          operation TEXT NOT NULL CHECK (operation IN (
            'conversation', 'vocabulary_analysis', 'phrase_analysis', 'synonym_analysis', 'connection_test'
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
        INSERT INTO llm_request_usage_v10
          SELECT * FROM llm_request_usage ORDER BY rowid;
      `)
      copyCountCheck(database, 'llm_request_usage', 'llm_request_usage_v10')
      database.exec(`
        DROP TABLE llm_request_usage;
        ALTER TABLE llm_request_usage_v10 RENAME TO llm_request_usage;
        CREATE INDEX llm_request_usage_model_started_at
          ON llm_request_usage (model_id, started_at);
        CREATE INDEX llm_request_usage_started_at ON llm_request_usage (started_at);
      `)
      if ((database.pragma('foreign_key_check') as unknown[]).length)
        throw new Error('Invalid synonym migration foreign keys')
    }
  },
  {
    // 词汇练习错题账本：独立于词库保存快照，不设外键与级联删除——
    // 源词条删除后仍可查看原错误记录；删除后重新收藏生成新 ID 视为新词条。
    version: 11,
    up: (database) =>
      database.exec(`
      CREATE TABLE vocabulary_practice_mistakes (
        id TEXT PRIMARY KEY NOT NULL,
        review_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        term TEXT NOT NULL CHECK(length(trim(term)) BETWEEN 1 AND 4000),
        submitted_meaning TEXT NOT NULL CHECK(length(trim(submitted_meaning)) BETWEEN 1 AND 2000),
        created_at TEXT NOT NULL,
        UNIQUE (review_id, entry_id)
      );
      CREATE INDEX vocabulary_practice_mistakes_entry_recent
        ON vocabulary_practice_mistakes (entry_id, created_at DESC, id DESC);
      CREATE INDEX vocabulary_practice_mistakes_recent
        ON vocabulary_practice_mistakes (created_at DESC, entry_id DESC);
    `)
  },
  {
    // 聊天平台接入（首版 Telegram）：连接、绑定、外部会话映射与消息、
    // 技能执行、入站执行记录（幂等键 platform+bot_id+event_id）、接收游标、
    // 待发回复与收藏确认。外部会话与桌面 conversations 分表存放，桌面
    // 会话列表无法读取外部历史；未授权或不支持的入站事件不保存正文。
    version: 12,
    up: (database) =>
      database.exec(`
      CREATE TABLE chat_channel_connections (
        connection_id TEXT PRIMARY KEY NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('telegram')),
        bot_id TEXT NOT NULL CHECK(length(bot_id) BETWEEN 1 AND 64),
        bot_username TEXT CHECK(bot_username IS NULL OR length(trim(bot_username)) BETWEEN 1 AND 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (platform, bot_id)
      );

      CREATE TABLE chat_channel_bindings (
        binding_id TEXT PRIMARY KEY NOT NULL,
        connection_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('telegram')),
        sender_id TEXT NOT NULL CHECK(length(sender_id) BETWEEN 1 AND 64),
        chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 64),
        display_name TEXT CHECK(display_name IS NULL OR length(display_name) BETWEEN 1 AND 128),
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'rejected', 'unbound')),
        requested_at TEXT NOT NULL,
        confirmed_at TEXT,
        unbound_at TEXT,
        FOREIGN KEY (connection_id) REFERENCES chat_channel_connections (connection_id)
      );
      CREATE UNIQUE INDEX chat_channel_bindings_pending
        ON chat_channel_bindings (connection_id) WHERE status = 'pending';
      CREATE UNIQUE INDEX chat_channel_bindings_active
        ON chat_channel_bindings (connection_id) WHERE status = 'active';

      CREATE TABLE chat_channel_binding_codes (
        connection_id TEXT PRIMARY KEY NOT NULL,
        code TEXT NOT NULL CHECK(length(code) = 6),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        FOREIGN KEY (connection_id) REFERENCES chat_channel_connections (connection_id)
      );

      CREATE TABLE chat_channel_sessions (
        session_id TEXT PRIMARY KEY NOT NULL,
        connection_id TEXT NOT NULL,
        session_key TEXT NOT NULL CHECK(length(session_key) BETWEEN 1 AND 512),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES chat_channel_connections (connection_id)
      );
      CREATE INDEX chat_channel_sessions_key
        ON chat_channel_sessions (session_key, created_at DESC, session_id DESC);

      CREATE TABLE chat_channel_active_sessions (
        session_key TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        FOREIGN KEY (session_id) REFERENCES chat_channel_sessions (session_id)
      );

      CREATE TABLE chat_channel_messages (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_channel_sessions (session_id)
      );
      CREATE INDEX chat_channel_messages_session_created_at
        ON chat_channel_messages (session_id, created_at);

      CREATE TABLE chat_channel_skill_executions (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL UNIQUE,
        assistant_message_id TEXT,
        skill_id TEXT NOT NULL CHECK(skill_id IN ('vocabulary', 'phrase', 'synonym')),
        arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json)),
        explanation_language TEXT NOT NULL CHECK(explanation_language IN ('zh-CN', 'en')),
        phase TEXT NOT NULL CHECK(phase IN (
          'started', 'analyzing', 'committing', 'summarizing', 'completed',
          'cancelled', 'failed', 'description_failed', 'description_cancelled')),
        batch_json TEXT CHECK(batch_json IS NULL OR json_valid(batch_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_channel_sessions (session_id),
        FOREIGN KEY (user_message_id) REFERENCES chat_channel_messages (id),
        FOREIGN KEY (assistant_message_id) REFERENCES chat_channel_messages (id)
      );
      CREATE INDEX chat_channel_skill_executions_session
        ON chat_channel_skill_executions (session_id, created_at);

      CREATE TABLE chat_channel_inbound (
        inbound_id TEXT PRIMARY KEY NOT NULL,
        connection_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('telegram')),
        bot_id TEXT NOT NULL,
        event_id INTEGER NOT NULL CHECK(event_id >= 0),
        message_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        text TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('command', 'message', 'confirmation', 'ignored')),
        status TEXT NOT NULL CHECK (status IN (
          'received', 'pending_confirmation', 'executing', 'succeeded', 'failed',
          'cancelled', 'expired', 'ignored', 'needs_attention')),
        session_id TEXT,
        execution_ref_json TEXT CHECK(execution_ref_json IS NULL OR json_valid(execution_ref_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (platform, bot_id, event_id),
        FOREIGN KEY (connection_id) REFERENCES chat_channel_connections (connection_id)
      );
      CREATE INDEX chat_channel_inbound_recoverable
        ON chat_channel_inbound (connection_id, created_at);

      CREATE TABLE chat_channel_cursors (
        connection_id TEXT PRIMARY KEY NOT NULL,
        offset INTEGER NOT NULL CHECK("offset" >= 0),
        updated_at TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES chat_channel_connections (connection_id)
      );

      CREATE TABLE chat_channel_replies (
        reply_id TEXT PRIMARY KEY NOT NULL,
        connection_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('telegram')),
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        session_id TEXT,
        inbound_id TEXT,
        text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 8000),
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        FOREIGN KEY (connection_id) REFERENCES chat_channel_connections (connection_id)
      );
      CREATE INDEX chat_channel_replies_pending
        ON chat_channel_replies (connection_id, status, created_at);

      CREATE TABLE chat_channel_confirmations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        connection_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        message_ref INTEGER NOT NULL,
        words_json TEXT NOT NULL CHECK(json_valid(words_json)),
        target_language TEXT NOT NULL CHECK (target_language IN ('en')),
        explanation_language TEXT NOT NULL CHECK (explanation_language IN ('zh-CN', 'en')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY (connection_id) REFERENCES chat_channel_connections (connection_id)
      );
      CREATE INDEX chat_channel_confirmations_scope
        ON chat_channel_confirmations (connection_id, session_id, chat_id, sender_id);
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

// 整表重建的行数守卫：目标行数必须与源一致，否则回滚整个迁移。
function copyCountCheck(database: Database.Database, source: string, target: string): void {
  const sourceCount = countRows(database, source)
  const targetCount = countRows(database, target)
  if (targetCount !== sourceCount) {
    throw new Error(
      `Migration row count mismatch: copied ${targetCount} of ${sourceCount} rows from ${source}`
    )
  }
}
