import { synonymBatchSchema } from '../shared/synonym'
import type Database from 'better-sqlite3'
import { conversationSkillArgumentsSchema } from '../shared/conversation'
import { vocabularyBatchSchema } from '../shared/vocabulary'
import { phraseBatchSchema } from '../shared/phrase'
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

interface ConversationRow {
  title: string
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
  retryable?: number
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

export class SqliteConversationRepository
  implements ConversationRepository, ConversationSkillRepository
{
  constructor(private readonly database: Database.Database) {}

  async create(conversation: StoredConversation): Promise<void> {
    try {
      this.insertConversation(conversation)
    } catch (error) {
      throw new ConversationPersistenceError('Unable to create conversation', { cause: error })
    }
  }

  private insertConversation(conversation: StoredConversation): void {
    this.database
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES (@id, @title, @createdAt, @updatedAt)`
      )
      .run(conversation)
  }

  async updateTitle(sessionId: string, title: string): Promise<void> {
    try {
      this.database.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, sessionId)
    } catch (error) {
      throw new ConversationPersistenceError('Unable to update conversation title', {
        cause: error
      })
    }
  }

  async list(): Promise<StoredConversation[]> {
    try {
      const rows = this.database
        .prepare(
          `SELECT id, title, created_at, updated_at
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
        .prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?')
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
          `SELECT m.id, m.session_id, m.role, m.content, m.created_at,
                  CASE WHEN e.phase IN (
                    'started', 'analyzing', 'committing', 'summarizing', 'cancelled', 'failed',
                    'description_failed', 'description_cancelled'
                  )
                       THEN 1 ELSE 0 END AS retryable
           FROM conversation_messages m
           LEFT JOIN conversation_skill_executions e ON e.user_message_id = m.id
           WHERE m.session_id = ?
           ORDER BY m.created_at ASC, m.rowid ASC`
        )
        .all(sessionId) as MessageRow[]

      return rows.map(toStoredMessage)
    } catch (error) {
      throw new ConversationPersistenceError('Unable to load conversation history', {
        cause: error
      })
    }
  }

  async appendMessage(message: StoredMessage, conversation?: StoredConversation): Promise<void> {
    try {
      // 插入消息与更新会话 updated_at 必须同事务，保证列表排序不依赖额外 touch。
      this.database.transaction(() => {
        if (conversation) this.insertConversation(conversation)
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

  async createExecution(
    execution: StoredConversationSkillExecution,
    userMessage: StoredMessage,
    conversation?: StoredConversation
  ): Promise<void> {
    try {
      this.database.transaction(() => {
        if (conversation) this.insertConversation(conversation)
        this.database
          .prepare(
            `INSERT INTO conversation_messages (id, session_id, role, content, created_at)
             VALUES (@id, @sessionId, @role, @content, @createdAt)`
          )
          .run(userMessage)
        this.database
          .prepare(
            `INSERT INTO conversation_skill_executions
             (id, session_id, user_message_id, skill_id, arguments_json,
              explanation_language, phase, created_at, updated_at)
             VALUES (@id, @sessionId, @userMessageId, @skillId, @argumentsJson,
                     @explanationLanguage, @phase, @createdAt, @updatedAt)`
          )
          .run({ ...execution, argumentsJson: JSON.stringify(execution.arguments) })
        this.database
          .prepare('UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?')
          .run(userMessage.createdAt, userMessage.sessionId)
      })()
    } catch (error) {
      throw new ConversationPersistenceError('Unable to create skill execution', { cause: error })
    }
  }

  async findExecutionByUserMessage(
    sessionId: string,
    userMessageId: string
  ): Promise<StoredConversationSkillExecution | undefined> {
    try {
      const row = this.database
        .prepare(
          `SELECT * FROM conversation_skill_executions
           WHERE session_id = ? AND user_message_id = ?`
        )
        .get(sessionId, userMessageId) as SkillExecutionRow | undefined
      return row ? toStoredSkillExecution(row) : undefined
    } catch (error) {
      throw new ConversationPersistenceError('Unable to find skill execution', { cause: error })
    }
  }

  async setExecutionPhase(executionId: string, phase: ConversationSkillPhase): Promise<void> {
    try {
      const result = this.database
        .prepare('UPDATE conversation_skill_executions SET phase = ?, updated_at = ? WHERE id = ?')
        .run(phase, new Date().toISOString(), executionId)
      if (result.changes !== 1) throw new Error('Skill execution not found')
    } catch (error) {
      throw new ConversationPersistenceError('Unable to update skill execution', { cause: error })
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
            `INSERT INTO conversation_messages (id, session_id, role, content, created_at)
             VALUES (@id, @sessionId, @role, @content, @createdAt)`
          )
          .run(assistantMessage)
        const result = this.database
          .prepare(
            `UPDATE conversation_skill_executions
             SET assistant_message_id = ?, phase = ?, updated_at = ?
             WHERE id = ? AND batch_json IS NOT NULL`
          )
          .run(assistantMessage.id, phase, assistantMessage.createdAt, executionId)
        if (result.changes !== 1) throw new Error('Committed skill execution not found')
        this.database
          .prepare('UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?')
          .run(assistantMessage.createdAt, assistantMessage.sessionId)
      })()
    } catch (error) {
      throw new ConversationPersistenceError('Unable to finish skill execution', { cause: error })
    }
  }
}

function toStoredConversation(row: ConversationRow): StoredConversation {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }
}

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    ...(row.retryable === 1 ? { retryable: true } : {})
  }
}

// 报告结构按 skill_id 判别解析；技能与报告不匹配的持久化数据视为损坏。
function toStoredSkillExecution(row: SkillExecutionRow): StoredConversationSkillExecution {
  // 数据库只保存文本技能（vocabulary/phrase/synonym）的参数；explore-phrase 走文件路径。
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
