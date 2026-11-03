import type { ConversationMessage } from '../../shared/conversation'
import type { StoredMessage } from './conversation-repository'

export function toConversationMessage(message: StoredMessage): ConversationMessage {
  return {
    messageId: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(message.speech ? { speech: message.speech } : {}),
    ...(message.retryable === true ? { retryable: true } : {})
  }
}
