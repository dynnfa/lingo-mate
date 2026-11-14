import type { ConversationSpeech } from '../../shared/speech'
import type { ModelRole } from '../llm/language-model'

export interface StoredConversation {
  title: string
  id: string
  createdAt: string
  updatedAt: string
}

export interface StoredMessage {
  id: string
  sessionId: string
  role: ModelRole
  content: string
  createdAt: string
  replyTask?: 'concept'
  speech?: ConversationSpeech
  retryable?: boolean
}

export interface ConversationRepository {
  create(conversation: StoredConversation): Promise<void>
  updateTitle(sessionId: string, title: string): Promise<void>
  list(): Promise<StoredConversation[]>
  find(sessionId: string): Promise<StoredConversation | undefined>
  history(sessionId: string): Promise<StoredMessage[]>
  appendMessage(message: StoredMessage, conversation?: StoredConversation): Promise<void>
}

export class ConversationPersistenceError extends Error {}

export class ConversationNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Conversation not found: ${sessionId}`)
    this.name = 'ConversationNotFoundError'
  }
}

// 同一会话同时只允许一个活动生成；由 Core 而不是 Renderer 保证。
export class ConversationBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`Conversation already has an active generation: ${sessionId}`)
    this.name = 'ConversationBusyError'
  }
}

export class MessageNotFoundError extends Error {
  constructor(readonly messageId: string) {
    super(`Message not found: ${messageId}`)
    this.name = 'MessageNotFoundError'
  }
}

// 重试目标不再是"最后一条未回答的 user 消息"，继续执行会造成对话分叉。
export class RetryNotAllowedError extends Error {
  constructor(readonly reason: string) {
    super(`Retry not allowed: ${reason}`)
    this.name = 'RetryNotAllowedError'
  }
}

export class RequestNotFoundError extends Error {
  constructor(readonly requestId: string) {
    super(`Active request not found: ${requestId}`)
    this.name = 'RequestNotFoundError'
  }
}

export class RequestBusyError extends Error {
  constructor(readonly requestId: string) {
    super(`Request already has an active generation: ${requestId}`)
    this.name = 'RequestBusyError'
  }
}
