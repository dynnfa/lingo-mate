import type Database from 'better-sqlite3'
import { conversationSkillArgumentsSchema } from '../shared/conversation'
import { vocabularyBatchSchema } from '../shared/vocabulary'
import { phraseBatchSchema } from '../shared/phrase'
import { synonymBatchSchema } from '../shared/synonym'
import {
  ConversationPersistenceError,
  type ConversationRepository,
  type StoredConversation,
  type StoredMessage
} from '../core/conversation/conversation-repository'
import type {
  ConversationSkillPhase,
  ConversationSkillRepository,
  StoredConversationSkillExecution
} from '../core/conversation/conversation-skill-repository'

// 外部渠道会话的持久化后端：与桌面 conversations 分表存放，实现同一 Core
// 接口以复用 ConversationModule；桌面会话列表无法读取外部历史。
// 渠道会话不展示标题：updateTitle 是保持接口完整的稳定空操作。

interface SessionRow {
  session_id: string
  connection_id: string
  session_key: string
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

interface SkillExecutionRow {
  id: string
  session_id: string
  user_message_id: string
  assistant_message_id: string | null
  skill_id: 'vocabulary' | 'phrase' | 'synonym'
  arguments_json: string
  explanation_language: 'zh-CN' | 'en'
  phase: ConversationSkillPhase
  batch_json: string | null
  created_at: string
  updated_at: string
}

export class SqliteChannelConversationRepository
  implements ConversationRepository, ConversationSkillRepository
{
  constructor(private readonly database: Database.Database) {}

  async create(conversation: StoredConversation): Promise<void> {
    // 渠道会话由 ChannelStore.createSession 负责登记（含 session_key 与活动指针）；
    // 此处仅保证 Core 语义下的存在性检查可用，不重复建行。
    void conversation
  }

  async updateTitle(sessionId: string, title: string): Promise<void> {
    // 渠道会话无标题列；调用方（渠道装配）已关闭标题生成。
    void sessionId
    void title
  }

  async list(): Promise<StoredConversation[]> {
    try {
      const rows = this.database
        .prepare(
          `SELECT session_id, connection_id, session_key, created_at, updated_at
           FROM chat_channel_sessions
           ORDER BY updated_at DESC, created_at DESC`
        )
        .all() as SessionRow[]
      return rows.map(toStoredConversation)
    } catch (error) {
      throw new ConversationPersistenceError('Unable to list channel sessions', { cause: error })
    }
  }

  async find(sessionId: string): Promise<StoredConversation | undefined> {
    try {
      const row = this.database
        .prepare(
          'SELECT session_id, connection_id, session_key, created_at, updated_at FROM chat_channel_sessions WHERE session_id = ?'
        )
        .get(sessionId) as SessionRow | undefined
      return row ? toStoredConversation(row) : undefined
    } catch (error) {
      throw new ConversationPersistenceError('Unable to find channel session', { cause: error })
    }
  }

  async history(sessionId: string): Promise<StoredMessage[]> {
    try {
      const rows = this.database
        .prepare(
          `SELECT id, session_id, role, content, created_at
           FROM chat_channel_messages
           WHERE session_id = ?
           ORDER BY created_at ASC, rowid ASC`
        )
        .all(sessionId) as MessageRow[]
      return rows.map(toStoredMessage)
    } catch (error) {
      throw new ConversationPersistenceError('Unable to load channel session history', {
        cause: error
      })
    }
  }

  async appendMessage(message: StoredMessage, conversation?: StoredConversation): Promise<void> {
    void conversation
    try {
      this.database
        .prepare(
          `INSERT INTO chat_channel_messages (id, session_id, role, content, created_at)
           VALUES (@id, @sessionId, @role, @content, @createdAt)`
        )
        .run(message)
      this.database
        .prepare(
          'UPDATE chat_channel_sessions SET updated_at = MAX(updated_at, ?) WHERE session_id = ?'
        )
        .run(message.createdAt, message.sessionId)
    } catch (error) {
      throw new ConversationPersistenceError('Unable to append channel message', { cause: error })
    }
  }

  async createExecution(
    execution: StoredConversationSkillExecution,
    userMessage: StoredMessage,
    conversation?: StoredConversation
  ): Promise<void> {
    void conversation
    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO chat_channel_messages (id, session_id, role, content, created_at)
             VALUES (@id, @sessionId, @role, @content, @createdAt)`
          )
          .run(userMessage)
        this.database
          .prepare(
            `INSERT INTO chat_channel_skill_executions
             (id, session_id, user_message_id, skill_id, arguments_json,
              explanation_language, phase, created_at, updated_at)
             VALUES (@id, @sessionId, @userMessageId, @skillId, @argumentsJson,
                     @explanationLanguage, @phase, @createdAt, @updatedAt)`
          )
          .run({ ...execution, argumentsJson: JSON.stringify(execution.arguments) })
        this.database
          .prepare(
            'UPDATE chat_channel_sessions SET updated_at = MAX(updated_at, ?) WHERE session_id = ?'
          )
          .run(userMessage.createdAt, userMessage.sessionId)
      })()
    } catch (error) {
      throw new ConversationPersistenceError('Unable to create channel skill execution', {
        cause: error
      })
    }
  }

  async findExecutionByUserMessage(
    sessionId: string,
    userMessageId: string
  ): Promise<StoredConversationSkillExecution | undefined> {
    try {
      const row = this.database
        .prepare(
          `SELECT * FROM chat_channel_skill_executions
           WHERE session_id = ? AND user_message_id = ?`
        )
        .get(sessionId, userMessageId) as SkillExecutionRow | undefined
      return row ? toStoredSkillExecution(row) : undefined
    } catch (error) {
      throw new ConversationPersistenceError('Unable to find channel skill execution', {
        cause: error
      })
    }
  }

  async setExecutionPhase(executionId: string, phase: ConversationSkillPhase): Promise<void> {
    try {
      const result = this.database
        .prepare('UPDATE chat_channel_skill_executions SET phase = ?, updated_at = ? WHERE id = ?')
        .run(phase, new Date().toISOString(), executionId)
      if (result.changes !== 1) throw new Error('Channel skill execution not found')
    } catch (error) {
      throw new ConversationPersistenceError('Unable to update channel skill execution', {
        cause: error
      })
    }
  }

  async finishExecution(
    executionId: string,
    phase: 'completed' | 'description_failed' | 'description_cancelled',
    assistantMessage: StoredMessage
  ): Promise<void> {
    try {
      this.database.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO chat_channel_messages (id, session_id, role, content, created_at)
             VALUES (@id, @sessionId, @role, @content, @createdAt)`
          )
          .run(assistantMessage)
        const result = this.database
          .prepare(
            `UPDATE chat_channel_skill_executions
             SET assistant_message_id = ?, phase = ?, updated_at = ?
             WHERE id = ? AND batch_json IS NOT NULL`
          )
          .run(assistantMessage.id, phase, assistantMessage.createdAt, executionId)
        if (result.changes !== 1) throw new Error('Committed channel skill execution not found')
        this.database
          .prepare(
            'UPDATE chat_channel_sessions SET updated_at = MAX(updated_at, ?) WHERE session_id = ?'
          )
          .run(assistantMessage.createdAt, assistantMessage.sessionId)
      })()
    } catch (error) {
      throw new ConversationPersistenceError('Unable to finish channel skill execution', {
        cause: error
      })
    }
  }
}

function toStoredConversation(row: SessionRow): StoredConversation {
  return {
    id: row.session_id,
    title: `channel:${row.session_key.slice(0, 40)}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
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

function toStoredSkillExecution(row: SkillExecutionRow): StoredConversationSkillExecution {
  const args = conversationSkillArgumentsSchema.parse(JSON.parse(row.arguments_json))
  const common = {
    id: row.id,
    sessionId: row.session_id,
    userMessageId: row.user_message_id,
    ...(row.assistant_message_id ? { assistantMessageId: row.assistant_message_id } : {}),
    arguments: args,
    explanationLanguage: row.explanation_language,
    phase: row.phase,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
  if (row.skill_id === 'synonym') {
    return {
      ...common,
      skillId: 'synonym',
      ...(row.batch_json ? { batch: synonymBatchSchema.parse(JSON.parse(row.batch_json)) } : {})
    }
  }
  if (row.skill_id === 'phrase') {
    return {
      ...common,
      skillId: 'phrase',
      ...(row.batch_json ? { batch: phraseBatchSchema.parse(JSON.parse(row.batch_json)) } : {})
    }
  }
  return {
    ...common,
    skillId: 'vocabulary',
    ...(row.batch_json ? { batch: vocabularyBatchSchema.parse(JSON.parse(row.batch_json)) } : {})
  }
}
