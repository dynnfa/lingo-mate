import type { ModelRole } from '../llm/language-model'

export interface StoredConversation {
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
}

export interface ConversationRepository {
  create(conversation: StoredConversation): Promise<void>
  list(): Promise<StoredConversation[]>
  find(sessionId: string): Promise<StoredConversation | undefined>
  history(sessionId: string): Promise<StoredMessage[]>
  appendMessage(message: StoredMessage): Promise<void>
}

export class ConversationPersistenceError extends Error {}

export class ConversationNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Conversation not found: ${sessionId}`)
    this.name = 'ConversationNotFoundError'
  }
}
