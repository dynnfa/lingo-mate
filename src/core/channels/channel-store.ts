import type {
  BindingCodeMatchOutcome,
  ChannelConfirmationScope,
  ChannelInboundKind,
  ChannelInboundStatus,
  ChannelExecutionRef,
  ChannelReplyStatus,
  ConsumeConfirmationOutcome,
  StoredChannelBinding,
  StoredChannelBindingCode,
  StoredChannelConnection,
  StoredChannelConfirmation,
  StoredChannelInbound,
  StoredChannelReply,
  StoredChannelSession
} from './channel-types'

// 渠道持久化端口：连接、绑定、会话映射、入站执行记录、游标与待发回复。
// 实现必须保证标注原子的方法在同一事务内完成，用于幂等与崩溃恢复。

export interface ChannelInboundPatch {
  status?: ChannelInboundStatus
  kind?: ChannelInboundKind
  sessionId?: string | null
  executionRef?: ChannelExecutionRef | null
}

export interface ChannelStore {
  // ---- 连接 ----
  saveConnection(connection: StoredChannelConnection): void
  findConnection(connectionId: string): StoredChannelConnection | undefined
  // 首版只有一个连接；设置页状态查询使用。
  findSoleConnection(): StoredChannelConnection | undefined
  // 更换 Bot 时清空旧账号归属、游标、会话与待发回复。
  replaceConnection(connection: StoredChannelConnection): void

  // ---- 绑定与绑定码 ----
  findActiveBindingBySender(
    connectionId: string,
    senderId: string
  ): StoredChannelBinding | undefined
  findActiveBinding(connectionId: string): StoredChannelBinding | undefined
  findPendingBinding(connectionId: string): StoredChannelBinding | undefined
  confirmPendingBinding(bindingId: string, confirmedAt: string): StoredChannelBinding | undefined
  rejectPendingBinding(bindingId: string): boolean
  markBindingUnbound(connectionId: string, unboundAt: string): void
  saveBindingCode(code: StoredChannelBindingCode): void
  // 原子：验证绑定码；不匹配时计数，超限后作废该码，匹配成功即消费。
  matchBindingCode(connectionId: string, code: string, now: string): BindingCodeMatchOutcome
  insertPendingBinding(binding: StoredChannelBinding): void

  // ---- 外部会话映射 ----
  findActiveSessionId(sessionKey: string): string | undefined
  // 原子：写入会话并将其设为该键的活动会话。
  createSession(session: StoredChannelSession): void

  // ---- 入站执行记录 ----
  // 幂等：eventId 已存在时返回已有记录，不重复创建。
  recordInbound(
    record: StoredChannelInbound
  ): { created: true } | { created: false; existing: StoredChannelInbound }
  updateInbound(inboundId: string, patch: ChannelInboundPatch, updatedAt: string): void
  listRecoverableInbound(connectionId: string): StoredChannelInbound[]

  // ---- 接收游标 ----
  getCursor(connectionId: string): number | null
  saveCursor(connectionId: string, offset: number, updatedAt: string): void

  // ---- 待发回复 ----
  saveReply(reply: StoredChannelReply): void
  // 原子：执行终态与待发回复是同一持久化事实。
  saveResult(inboundId: string, status: ChannelInboundStatus, reply: StoredChannelReply): void
  markReplySent(replyId: string, sentAt: string): void
  markReplyAttemptFailed(replyId: string, updatedAt: string, status: ChannelReplyStatus): void
  listPendingReplies(connectionId: string): StoredChannelReply[]
  // 解绑或更换 Bot 时丢弃未发送回复。
  dropPendingReplies(connectionId: string): void

  // ---- 收藏确认 ----
  // 保存时替换该会话已有的活动确认（每会话至多一个）。
  saveConfirmation(confirmation: StoredChannelConfirmation): void
  findActiveConfirmation(scope: ChannelConfirmationScope): StoredChannelConfirmation | undefined
  // 原子：一次性消费；过期同样不可消费。
  consumeConfirmation(operationId: string, consumedAt: string): ConsumeConfirmationOutcome
  // 使该会话的活动确认失效（取消、重启恢复时）。
  invalidateSessionConfirmation(scope: ChannelConfirmationScope): void
  // 使该连接下全部活动确认失效（重启恢复：旧确认不再可用）。
  invalidateAllConfirmations(connectionId: string): void
  // 使该账号归属的全部活动确认失效（解绑时）。
  invalidateConfirmationsForOwner(connectionId: string, senderId: string, chatId: string): void
}
