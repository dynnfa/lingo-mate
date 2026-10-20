import type Database from 'better-sqlite3'
import type {
  BindingCodeMatchOutcome,
  ChannelConfirmationScope,
  ChannelReplyStatus,
  ConsumeConfirmationOutcome,
  StoredChannelBinding,
  StoredChannelBindingCode,
  StoredChannelConnection,
  StoredChannelConfirmation,
  StoredChannelInbound,
  ChannelInboundStatus,
  StoredChannelReply,
  StoredChannelSession
} from '../core/channels/channel-types'
import type { ChannelInboundPatch, ChannelStore } from '../core/channels/channel-store'

// 聊天平台渠道持久化：实现 Core 的 ChannelStore 端口。标注原子的方法
// （绑定码匹配、确认消费、会话激活）在单个事务内完成。

interface InboundRow {
  inbound_id: string
  connection_id: string
  platform: 'telegram'
  bot_id: string
  event_id: number
  message_id: number
  chat_id: string
  sender_id: string
  sent_at: string
  received_at: string
  text: string | null
  kind: StoredChannelInbound['kind']
  status: StoredChannelInbound['status']
  session_id: string | null
  execution_ref_json: string | null
  created_at: string
  updated_at: string
}

interface BindingCodeRow {
  connection_id: string
  code: string
  created_at: string
  expires_at: string
  consumed_at: string | null
  attempts: number
}

interface BindingRow {
  binding_id: string
  connection_id: string
  platform: 'telegram'
  sender_id: string
  chat_id: string
  display_name: string | null
  status: StoredChannelBinding['status']
  requested_at: string
  confirmed_at: string | null
  unbound_at: string | null
}

interface ConnectionRow {
  connection_id: string
  platform: 'telegram'
  bot_id: string
  bot_username: string | null
  created_at: string
  updated_at: string
}

interface ReplyRow {
  reply_id: string
  connection_id: string
  platform: 'telegram'
  chat_id: string
  sender_id: string
  session_id: string | null
  inbound_id: string | null
  text: string
  status: ChannelReplyStatus
  attempts: number
  created_at: string
  updated_at: string
  sent_at: string | null
}

interface ConfirmationRow {
  operation_id: string
  connection_id: string
  session_id: string
  chat_id: string
  sender_id: string
  message_ref: number
  words_json: string
  target_language: 'en'
  explanation_language: 'zh-CN' | 'en'
  created_at: string
  expires_at: string
  consumed_at: string | null
}

export class SqliteChannelStore implements ChannelStore {
  constructor(private readonly database: Database.Database) {}

  // ---- 连接 ----

  saveConnection(connection: StoredChannelConnection): void {
    this.database
      .prepare(
        `INSERT INTO chat_channel_connections
         (connection_id, platform, bot_id, bot_username, created_at, updated_at)
         VALUES (@connectionId, @platform, @botId, @botUsername, @createdAt, @updatedAt)
         ON CONFLICT (connection_id) DO UPDATE SET
           platform = excluded.platform,
           bot_id = excluded.bot_id,
           bot_username = excluded.bot_username,
           updated_at = excluded.updated_at`
      )
      .run(connection)
  }

  findConnection(connectionId: string): StoredChannelConnection | undefined {
    const row = this.database
      .prepare('SELECT * FROM chat_channel_connections WHERE connection_id = ?')
      .get(connectionId) as ConnectionRow | undefined
    return row ? toConnection(row) : undefined
  }

  findSoleConnection(): StoredChannelConnection | undefined {
    const row = this.database
      .prepare('SELECT * FROM chat_channel_connections ORDER BY created_at ASC LIMIT 1')
      .get() as ConnectionRow | undefined
    return row ? toConnection(row) : undefined
  }

  // 更换 Bot：同一事务内替换连接并清空旧账号归属、会话、入站、游标与回复。
  replaceConnection(connection: StoredChannelConnection): void {
    this.database
      .transaction(() => {
        this.database.exec('DELETE FROM chat_channel_confirmations')
        this.database.exec('DELETE FROM chat_channel_replies')
        this.database.exec('DELETE FROM chat_channel_cursors')
        this.database.exec('DELETE FROM chat_channel_inbound')
        this.database.exec('DELETE FROM chat_channel_active_sessions')
        this.database.exec('DELETE FROM chat_channel_skill_executions')
        this.database.exec('DELETE FROM chat_channel_messages')
        this.database.exec('DELETE FROM chat_channel_sessions')
        this.database.exec('DELETE FROM chat_channel_binding_codes')
        this.database.exec('DELETE FROM chat_channel_bindings')
        this.database.exec('DELETE FROM chat_channel_connections')
        this.saveConnection(connection)
      })
      .immediate()
  }

  // ---- 绑定与绑定码 ----

  findActiveBindingBySender(
    connectionId: string,
    senderId: string
  ): StoredChannelBinding | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM chat_channel_bindings
         WHERE connection_id = ? AND sender_id = ? AND status = 'active'`
      )
      .get(connectionId, senderId) as BindingRow | undefined
    return row ? toBinding(row) : undefined
  }

  findActiveBinding(connectionId: string): StoredChannelBinding | undefined {
    const row = this.database
      .prepare(`SELECT * FROM chat_channel_bindings WHERE connection_id = ? AND status = 'active'`)
      .get(connectionId) as BindingRow | undefined
    return row ? toBinding(row) : undefined
  }

  findPendingBinding(connectionId: string): StoredChannelBinding | undefined {
    const row = this.database
      .prepare(`SELECT * FROM chat_channel_bindings WHERE connection_id = ? AND status = 'pending'`)
      .get(connectionId) as BindingRow | undefined
    return row ? toBinding(row) : undefined
  }

  insertPendingBinding(binding: StoredChannelBinding): void {
    this.database
      .prepare(
        `INSERT INTO chat_channel_bindings
         (binding_id, connection_id, platform, sender_id, chat_id, display_name,
          status, requested_at, confirmed_at, unbound_at)
         VALUES (@bindingId, @connectionId, @platform, @senderId, @chatId, @displayName,
                 @status, @requestedAt, @confirmedAt, @unboundAt)`
      )
      .run(binding)
  }

  confirmPendingBinding(bindingId: string, confirmedAt: string): StoredChannelBinding | undefined {
    const result = this.database
      .prepare(
        `UPDATE chat_channel_bindings
         SET status = 'active', confirmed_at = ?
         WHERE binding_id = ? AND status = 'pending'`
      )
      .run(confirmedAt, bindingId)
    if (result.changes !== 1) return undefined
    const row = this.database
      .prepare('SELECT * FROM chat_channel_bindings WHERE binding_id = ?')
      .get(bindingId) as BindingRow
    return toBinding(row)
  }

  rejectPendingBinding(bindingId: string): boolean {
    const result = this.database
      .prepare(`DELETE FROM chat_channel_bindings WHERE binding_id = ? AND status = 'pending'`)
      .run(bindingId)
    return result.changes === 1
  }

  markBindingUnbound(connectionId: string, unboundAt: string): void {
    this.database
      .prepare(
        `UPDATE chat_channel_bindings SET status = 'unbound', unbound_at = ?
                WHERE connection_id = ? AND status = 'active'`
      )
      .run(unboundAt, connectionId)
  }

  saveBindingCode(code: StoredChannelBindingCode): void {
    // 新码替换旧码：一次只保留一个未消费或已作废的当前码。
    this.database
      .prepare(
        `INSERT INTO chat_channel_binding_codes
         (connection_id, code, created_at, expires_at, consumed_at, attempts)
         VALUES (@connectionId, @code, @createdAt, @expiresAt, @consumedAt, @attempts)
         ON CONFLICT (connection_id) DO UPDATE SET
           code = excluded.code,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           consumed_at = excluded.consumed_at,
           attempts = excluded.attempts`
      )
      .run(code)
  }

  matchBindingCode(connectionId: string, code: string, now: string): BindingCodeMatchOutcome {
    return this.database
      .transaction((): BindingCodeMatchOutcome => {
        const row = this.database
          .prepare('SELECT * FROM chat_channel_binding_codes WHERE connection_id = ?')
          .get(connectionId) as BindingCodeRow | undefined
        if (!row || row.consumed_at !== null) return 'none'
        if (Date.parse(row.expires_at) <= Date.parse(now)) {
          this.database
            .prepare(
              'UPDATE chat_channel_binding_codes SET consumed_at = ? WHERE connection_id = ?'
            )
            .run(now, connectionId)
          return 'expired'
        }
        if (row.code !== code) {
          const attempts = row.attempts + 1
          if (attempts >= 5) {
            this.database
              .prepare(
                'UPDATE chat_channel_binding_codes SET attempts = ?, consumed_at = ? WHERE connection_id = ?'
              )
              .run(attempts, now, connectionId)
            return 'exhausted'
          }
          this.database
            .prepare('UPDATE chat_channel_binding_codes SET attempts = ? WHERE connection_id = ?')
            .run(attempts, connectionId)
          return 'mismatch'
        }
        this.database
          .prepare('UPDATE chat_channel_binding_codes SET consumed_at = ? WHERE connection_id = ?')
          .run(now, connectionId)
        return 'matched'
      })
      .immediate()
  }

  // ---- 外部会话映射 ----

  findActiveSessionId(sessionKey: string): string | undefined {
    const row = this.database
      .prepare('SELECT session_id FROM chat_channel_active_sessions WHERE session_key = ?')
      .get(sessionKey) as { session_id: string } | undefined
    return row?.session_id
  }

  createSession(session: StoredChannelSession): void {
    this.database
      .transaction(() => {
        this.database
          .prepare(
            `INSERT INTO chat_channel_sessions
             (session_id, connection_id, session_key, created_at, updated_at)
             VALUES (@sessionId, @connectionId, @sessionKey, @createdAt, @updatedAt)`
          )
          .run(session)
        this.database
          .prepare(
            `INSERT INTO chat_channel_active_sessions (session_key, session_id)
             VALUES (@sessionKey, @sessionId)
             ON CONFLICT (session_key) DO UPDATE SET session_id = excluded.session_id`
          )
          .run(session)
      })
      .immediate()
  }

  // ---- 入站执行记录 ----

  recordInbound(
    record: StoredChannelInbound
  ): { created: true } | { created: false; existing: StoredChannelInbound } {
    return this.database
      .transaction(() => {
        const existing = this.database
          .prepare(
            `SELECT * FROM chat_channel_inbound WHERE platform = ? AND bot_id = ? AND event_id = ?`
          )
          .get(record.platform, record.botId, record.eventId) as InboundRow | undefined
        if (existing) return { created: false as const, existing: toInbound(existing) }
        this.database
          .prepare(
            `INSERT INTO chat_channel_inbound
           (inbound_id, connection_id, platform, bot_id, event_id, message_id, chat_id,
            sender_id, sent_at, received_at, text, kind, status, session_id,
            execution_ref_json, created_at, updated_at)
           VALUES (@inboundId, @connectionId, @platform, @botId, @eventId, @messageId, @chatId,
                   @senderId, @sentAt, @receivedAt, @text, @kind, @status, @sessionId,
                   @executionRefJson, @createdAt, @updatedAt)`
          )
          .run({ ...record, executionRefJson: toExecutionRefJson(record.executionRef) })
        return { created: true as const }
      })
      .immediate()
  }

  updateInbound(inboundId: string, patch: ChannelInboundPatch, updatedAt: string): void {
    this.database
      .prepare(
        `UPDATE chat_channel_inbound SET
           status = COALESCE(@status, status),
           kind = COALESCE(@kind, kind),
           session_id = COALESCE(@sessionId, session_id),
           execution_ref_json = COALESCE(@executionRefJson, execution_ref_json),
           updated_at = @updatedAt
         WHERE inbound_id = @inboundId`
      )
      .run({
        status: patch.status ?? null,
        kind: patch.kind ?? null,
        sessionId: patch.sessionId ?? null,
        executionRefJson: toExecutionRefJson(patch.executionRef ?? null),
        updatedAt,
        inboundId
      })
  }

  listRecoverableInbound(connectionId: string): StoredChannelInbound[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_channel_inbound
         WHERE connection_id = ? AND status IN ('received', 'pending_confirmation', 'executing')
         ORDER BY created_at ASC, inbound_id ASC`
      )
      .all(connectionId) as InboundRow[]
    return rows.map(toInbound)
  }

  // ---- 接收游标 ----

  getCursor(connectionId: string): number | null {
    const row = this.database
      .prepare('SELECT "offset" AS offset_value FROM chat_channel_cursors WHERE connection_id = ?')
      .get(connectionId) as { offset_value: number } | undefined
    return row?.offset_value ?? null
  }

  saveCursor(connectionId: string, offset: number, updatedAt: string): void {
    this.database
      .prepare(
        `INSERT INTO chat_channel_cursors (connection_id, "offset", updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (connection_id) DO UPDATE SET "offset" = excluded."offset", updated_at = excluded.updated_at`
      )
      .run(connectionId, offset, updatedAt)
  }

  // ---- 待发回复 ----

  saveReply(reply: StoredChannelReply): void {
    this.database
      .prepare(
        `INSERT INTO chat_channel_replies
         (reply_id, connection_id, platform, chat_id, sender_id, session_id, inbound_id,
          text, status, attempts, created_at, updated_at, sent_at)
         VALUES (@replyId, @connectionId, @platform, @chatId, @senderId, @sessionId, @inboundId,
                 @text, @status, @attempts, @createdAt, @updatedAt, @sentAt)`
      )
      .run(reply)
  }

  saveResult(inboundId: string, status: ChannelInboundStatus, reply: StoredChannelReply): void {
    this.database
      .transaction(() => {
        const updated = this.database
          .prepare(
            `UPDATE chat_channel_inbound
          SET status = ?, session_id = COALESCE(?, session_id), updated_at = ?
          WHERE inbound_id = ?`
          )
          .run(status, reply.sessionId, reply.createdAt, inboundId)
        if (updated.changes !== 1) throw new Error('Channel inbound not found')
        this.saveReply(reply)
      })
      .immediate()
  }

  markReplySent(replyId: string, sentAt: string): void {
    this.database
      .prepare(
        `UPDATE chat_channel_replies SET status = 'sent', sent_at = ?, updated_at = ?
         WHERE reply_id = ?`
      )
      .run(sentAt, sentAt, replyId)
  }

  markReplyAttemptFailed(replyId: string, updatedAt: string, status: ChannelReplyStatus): void {
    this.database
      .prepare(
        `UPDATE chat_channel_replies SET status = ?, attempts = attempts + 1, updated_at = ?
         WHERE reply_id = ?`
      )
      .run(status, updatedAt, replyId)
  }

  listPendingReplies(connectionId: string): StoredChannelReply[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM chat_channel_replies
         WHERE connection_id = ? AND status = 'pending'
         ORDER BY created_at ASC, reply_id ASC`
      )
      .all(connectionId) as ReplyRow[]
    return rows.map(toReply)
  }

  dropPendingReplies(connectionId: string): void {
    this.database
      .prepare(
        `UPDATE chat_channel_replies SET status = 'failed' WHERE connection_id = ? AND status = 'pending'`
      )
      .run(connectionId)
  }

  // ---- 收藏确认 ----

  saveConfirmation(confirmation: StoredChannelConfirmation): void {
    this.database
      .transaction(() => {
        // 每会话至多一个活动确认：保存前作废旧的。
        this.database
          .prepare(
            `UPDATE chat_channel_confirmations SET consumed_at = ?
             WHERE connection_id = ? AND session_id = ? AND chat_id = ? AND sender_id = ?
               AND consumed_at IS NULL`
          )
          .run(
            confirmation.createdAt,
            confirmation.connectionId,
            confirmation.sessionId,
            confirmation.chatId,
            confirmation.senderId
          )
        this.database
          .prepare(
            `INSERT INTO chat_channel_confirmations
             (operation_id, connection_id, session_id, chat_id, sender_id, message_ref,
              words_json, target_language, explanation_language, created_at, expires_at, consumed_at)
             VALUES (@operationId, @connectionId, @sessionId, @chatId, @senderId, @messageRef,
                     @wordsJson, @targetLanguage, @explanationLanguage, @createdAt, @expiresAt, @consumedAt)`
          )
          .run({ ...confirmation, wordsJson: JSON.stringify(confirmation.words) })
      })
      .immediate()
  }

  // 只按归属与未消费过滤：是否过期由消费方按其时钟判断（consumeConfirmation
  // 用显式时间戳原子校验），存储层不依赖真实当前时间。
  findActiveConfirmation(scope: ChannelConfirmationScope): StoredChannelConfirmation | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM chat_channel_confirmations
         WHERE connection_id = ? AND session_id = ? AND chat_id = ? AND sender_id = ?
           AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(scope.connectionId, scope.sessionId, scope.chatId, scope.senderId) as
      ConfirmationRow | undefined
    return row ? toConfirmation(row) : undefined
  }

  consumeConfirmation(operationId: string, consumedAt: string): ConsumeConfirmationOutcome {
    return this.database
      .transaction((): ConsumeConfirmationOutcome => {
        const row = this.database
          .prepare('SELECT * FROM chat_channel_confirmations WHERE operation_id = ?')
          .get(operationId) as ConfirmationRow | undefined
        if (!row || row.consumed_at !== null) return { outcome: 'missing' }
        if (Date.parse(row.expires_at) <= Date.parse(consumedAt)) {
          this.database
            .prepare('UPDATE chat_channel_confirmations SET consumed_at = ? WHERE operation_id = ?')
            .run(consumedAt, operationId)
          return {
            outcome: 'expired',
            confirmation: toConfirmation({ ...row, consumed_at: consumedAt })
          }
        }
        this.database
          .prepare('UPDATE chat_channel_confirmations SET consumed_at = ? WHERE operation_id = ?')
          .run(consumedAt, operationId)
        return {
          outcome: 'consumed',
          confirmation: toConfirmation({ ...row, consumed_at: consumedAt })
        }
      })
      .immediate()
  }

  invalidateSessionConfirmation(scope: ChannelConfirmationScope): void {
    this.database
      .prepare(
        `UPDATE chat_channel_confirmations SET consumed_at = ?
         WHERE connection_id = ? AND session_id = ? AND chat_id = ? AND sender_id = ?
           AND consumed_at IS NULL`
      )
      .run(
        new Date(0).toISOString(),
        scope.connectionId,
        scope.sessionId,
        scope.chatId,
        scope.senderId
      )
  }

  invalidateAllConfirmations(connectionId: string): void {
    this.database
      .prepare(
        `UPDATE chat_channel_confirmations SET consumed_at = ?
         WHERE connection_id = ? AND consumed_at IS NULL`
      )
      .run(new Date(0).toISOString(), connectionId)
  }

  invalidateConfirmationsForOwner(connectionId: string, senderId: string, chatId: string): void {
    this.database
      .prepare(
        `UPDATE chat_channel_confirmations SET consumed_at = ?
         WHERE connection_id = ? AND sender_id = ? AND chat_id = ? AND consumed_at IS NULL`
      )
      .run(new Date(0).toISOString(), connectionId, senderId, chatId)
  }
}

function toExecutionRefJson(ref: StoredChannelInbound['executionRef']): string | null {
  return ref ? JSON.stringify(ref) : null
}

function toConnection(row: ConnectionRow): StoredChannelConnection {
  return {
    connectionId: row.connection_id,
    platform: row.platform,
    botId: row.bot_id,
    botUsername: row.bot_username,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toBinding(row: BindingRow): StoredChannelBinding {
  return {
    bindingId: row.binding_id,
    connectionId: row.connection_id,
    platform: row.platform,
    senderId: row.sender_id,
    chatId: row.chat_id,
    displayName: row.display_name,
    status: row.status,
    requestedAt: row.requested_at,
    confirmedAt: row.confirmed_at,
    unboundAt: row.unbound_at
  }
}

function toInbound(row: InboundRow): StoredChannelInbound {
  return {
    inboundId: row.inbound_id,
    connectionId: row.connection_id,
    platform: row.platform,
    botId: row.bot_id,
    eventId: row.event_id,
    messageId: row.message_id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    text: row.text,
    kind: row.kind,
    status: row.status,
    sessionId: row.session_id,
    executionRef: row.execution_ref_json
      ? (JSON.parse(row.execution_ref_json) as StoredChannelInbound['executionRef'])
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toReply(row: ReplyRow): StoredChannelReply {
  return {
    replyId: row.reply_id,
    connectionId: row.connection_id,
    platform: row.platform,
    chatId: row.chat_id,
    senderId: row.sender_id,
    sessionId: row.session_id,
    inboundId: row.inbound_id,
    text: row.text,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at
  }
}

function toConfirmation(row: ConfirmationRow): StoredChannelConfirmation {
  return {
    operationId: row.operation_id,
    connectionId: row.connection_id,
    sessionId: row.session_id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    messageRef: row.message_ref,
    words: JSON.parse(row.words_json) as string[],
    targetLanguage: row.target_language,
    explanationLanguage: row.explanation_language,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at
  }
}
