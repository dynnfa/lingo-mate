import { DEFAULT_CHANNEL_POLICIES } from '../channel-policies'
import type { ChannelStore } from '../channel-store'
import type {
  StoredChannelBinding,
  StoredChannelBindingCode,
  StoredChannelConfirmation,
  StoredChannelConnection,
  StoredChannelInbound,
  StoredChannelReply,
  StoredChannelSession
} from '../channel-types'

// 渠道模块与 Main 服务测试共用的内存渠道存储替身。

export function memoryChannelStore(): ChannelStore & {
  connections: StoredChannelConnection[]
  bindings: StoredChannelBinding[]
  bindingCodes: StoredChannelBindingCode[]
  sessions: StoredChannelSession[]
  activeSessions: Map<string, string>
  inbound: StoredChannelInbound[]
  replies: StoredChannelReply[]
  confirmations: StoredChannelConfirmation[]
  cursor: Map<string, number>
} {
  const connections: StoredChannelConnection[] = []
  const bindings: StoredChannelBinding[] = []
  const bindingCodes: StoredChannelBindingCode[] = []
  const sessions: StoredChannelSession[] = []
  const activeSessions = new Map<string, string>()
  const inbound: StoredChannelInbound[] = []
  const replies: StoredChannelReply[] = []
  const confirmations: StoredChannelConfirmation[] = []
  const cursor = new Map<string, number>()
  return {
    connections,
    bindings,
    bindingCodes,
    sessions,
    activeSessions,
    inbound,
    replies,
    confirmations,
    cursor,
    saveConnection(connection) {
      const index = connections.findIndex((item) => item.connectionId === connection.connectionId)
      if (index === -1) connections.push(connection)
      else connections[index] = connection
    },
    findConnection(connectionId) {
      return connections.find((item) => item.connectionId === connectionId)
    },
    findSoleConnection() {
      return connections[0]
    },
    replaceConnection(connection) {
      connections.length = 0
      connections.push(connection)
      const keep = bindings.filter((item) => item.connectionId !== connection.connectionId)
      bindings.length = 0
      bindings.push(...keep)
      const keepSessions = sessions.filter((item) => item.connectionId !== connection.connectionId)
      sessions.length = 0
      sessions.push(...keepSessions)
      for (const key of [...activeSessions.keys()]) {
        if (key.includes(connection.connectionId)) activeSessions.delete(key)
      }
      const keepInbound = inbound.filter((item) => item.connectionId !== connection.connectionId)
      inbound.length = 0
      inbound.push(...keepInbound)
      const keepReplies = replies.filter((item) => item.connectionId !== connection.connectionId)
      replies.length = 0
      replies.push(...keepReplies)
      cursor.delete(connection.connectionId)
      connections.push(connection)
    },
    findActiveBindingBySender(connectionId, senderId) {
      return bindings.find(
        (item) =>
          item.connectionId === connectionId &&
          item.senderId === senderId &&
          item.status === 'active'
      )
    },
    findActiveBinding(connectionId) {
      return bindings.find((item) => item.connectionId === connectionId && item.status === 'active')
    },
    findPendingBinding(connectionId) {
      return bindings.find(
        (item) => item.connectionId === connectionId && item.status === 'pending'
      )
    },
    insertPendingBinding(binding) {
      bindings.push(binding)
    },
    confirmPendingBinding(bindingId, confirmedAt) {
      const binding = bindings.find((item) => item.bindingId === bindingId)
      if (!binding || binding.status !== 'pending') return undefined
      binding.status = 'active'
      binding.confirmedAt = confirmedAt
      return binding
    },
    rejectPendingBinding(bindingId) {
      const index = bindings.findIndex((item) => item.bindingId === bindingId)
      if (index === -1 || bindings[index].status !== 'pending') return false
      bindings.splice(index, 1)
      return true
    },
    markBindingUnbound(connectionId, unboundAt) {
      for (const binding of bindings) {
        if (binding.connectionId === connectionId && binding.status === 'active') {
          binding.status = 'unbound'
          binding.unboundAt = unboundAt
        }
      }
    },
    saveBindingCode(code) {
      const index = bindingCodes.findIndex((item) => item.connectionId === code.connectionId)
      if (index === -1) bindingCodes.push(code)
      else bindingCodes[index] = code
    },
    matchBindingCode(connectionId, code, now) {
      const active = bindingCodes.find(
        (item) => item.connectionId === connectionId && item.consumedAt === null
      )
      if (!active) return 'none'
      if (Date.parse(active.expiresAt) <= Date.parse(now)) {
        active.consumedAt = now
        return 'expired'
      }
      if (active.code !== code) {
        active.attempts += 1
        if (active.attempts >= DEFAULT_CHANNEL_POLICIES.bindingCodeMaxAttempts) {
          active.consumedAt = now
          return 'exhausted'
        }
        return 'mismatch'
      }
      active.consumedAt = now
      return 'matched'
    },
    findActiveSessionId(sessionKey) {
      return activeSessions.get(sessionKey)
    },
    createSession(session) {
      sessions.push(session)
      activeSessions.set(session.sessionKey, session.sessionId)
    },
    recordInbound(record) {
      const existing = inbound.find(
        (item) =>
          item.platform === record.platform &&
          item.botId === record.botId &&
          item.eventId === record.eventId
      )
      if (existing) return { created: false as const, existing }
      inbound.push(record)
      return { created: true as const }
    },
    updateInbound(inboundId, patch, updatedAt) {
      const record = inbound.find((item) => item.inboundId === inboundId)
      if (!record) return
      Object.assign(record, patch, { updatedAt })
    },
    listRecoverableInbound(connectionId) {
      return inbound.filter(
        (item) =>
          item.connectionId === connectionId &&
          ['received', 'pending_confirmation', 'executing'].includes(item.status)
      )
    },
    getCursor(connectionId) {
      return cursor.get(connectionId) ?? null
    },
    saveCursor(connectionId, offset) {
      cursor.set(connectionId, offset)
    },
    saveReply(reply) {
      replies.push(reply)
    },
    saveResult(inboundId, status, reply) {
      const record = inbound.find((item) => item.inboundId === inboundId)
      if (!record) throw new Error('Channel inbound not found')
      record.status = status
      if (reply.sessionId) record.sessionId = reply.sessionId
      record.updatedAt = reply.createdAt
      replies.push(reply)
    },
    markReplySent(replyId, sentAt) {
      const reply = replies.find((item) => item.replyId === replyId)
      if (reply) {
        reply.status = 'sent'
        reply.sentAt = sentAt
      }
    },
    markReplyAttemptFailed(replyId, updatedAt, status) {
      const reply = replies.find((item) => item.replyId === replyId)
      if (reply) {
        reply.attempts += 1
        reply.status = status
        reply.updatedAt = updatedAt
      }
    },
    listPendingReplies(connectionId) {
      return replies.filter(
        (item) => item.connectionId === connectionId && item.status === 'pending'
      )
    },
    dropPendingReplies(connectionId) {
      for (const reply of replies) {
        if (reply.connectionId === connectionId && reply.status === 'pending')
          reply.status = 'failed'
      }
    },
    saveConfirmation(confirmation) {
      const index = confirmations.findIndex(
        (item) =>
          item.connectionId === confirmation.connectionId &&
          item.sessionId === confirmation.sessionId &&
          item.consumedAt === null
      )
      if (index === -1) confirmations.push(confirmation)
      else confirmations[index] = confirmation
    },
    findActiveConfirmation(scope) {
      return confirmations.find(
        (item) =>
          item.connectionId === scope.connectionId &&
          item.sessionId === scope.sessionId &&
          item.chatId === scope.chatId &&
          item.senderId === scope.senderId &&
          item.consumedAt === null
      )
    },
    consumeConfirmation(operationId, consumedAt) {
      const confirmation = confirmations.find((item) => item.operationId === operationId)
      if (!confirmation) return { outcome: 'missing' as const }
      if (confirmation.consumedAt !== null) return { outcome: 'missing' as const }
      if (Date.parse(confirmation.expiresAt) <= Date.parse(consumedAt)) {
        confirmation.consumedAt = consumedAt
        return { outcome: 'expired' as const, confirmation }
      }
      confirmation.consumedAt = consumedAt
      return { outcome: 'consumed' as const, confirmation }
    },
    invalidateSessionConfirmation(scope) {
      for (const confirmation of confirmations) {
        if (
          confirmation.connectionId === scope.connectionId &&
          confirmation.sessionId === scope.sessionId &&
          confirmation.chatId === scope.chatId &&
          confirmation.senderId === scope.senderId &&
          confirmation.consumedAt === null
        ) {
          confirmation.consumedAt = new Date(0).toISOString()
        }
      }
    },
    invalidateAllConfirmations(connectionId) {
      for (const confirmation of confirmations) {
        if (confirmation.connectionId === connectionId && confirmation.consumedAt === null) {
          confirmation.consumedAt = new Date(0).toISOString()
        }
      }
    },
    invalidateConfirmationsForOwner(connectionId, senderId, chatId) {
      for (const confirmation of confirmations) {
        if (
          confirmation.connectionId === connectionId &&
          confirmation.senderId === senderId &&
          confirmation.chatId === chatId &&
          confirmation.consumedAt === null
        ) {
          confirmation.consumedAt = new Date(0).toISOString()
        }
      }
    }
  }
}
