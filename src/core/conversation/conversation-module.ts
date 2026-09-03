import { randomUUID } from 'node:crypto'
import type {
  ConversationEvent,
  ConversationMessage,
  ConversationSummary,
  LoadedConversation,
  SendMessageInput,
  SendMessageResult
} from '../../shared/conversation'
import type { LanguageModel, ModelMessage } from '../llm/language-model'
import {
  ConversationNotFoundError,
  ConversationPersistenceError,
  type ConversationRepository,
  type StoredConversation,
  type StoredMessage
} from './conversation-repository'

export type ConversationEventListener = (event: ConversationEvent) => void

export class ConversationModule {
  private readonly activeRequests = new Map<string, AbortController>()

  constructor(
    private readonly model: LanguageModel,
    private readonly repository: ConversationRepository
  ) {}

  async createConversation(): Promise<ConversationSummary> {
    const now = new Date().toISOString()
    const conversation: StoredConversation = { id: randomUUID(), createdAt: now, updatedAt: now }
    await this.withPersistence(() => this.repository.create(conversation))
    return toSummary(conversation)
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const conversations = await this.withPersistence(() => this.repository.list())
    return conversations.map(toSummary).sort(byMostRecent)
  }

  async loadConversation(sessionId: string): Promise<LoadedConversation> {
    const conversation = await this.withPersistence(() => this.repository.find(sessionId))
    if (!conversation) {
      throw new ConversationNotFoundError(sessionId)
    }

    const messages = await this.withPersistence(() => this.repository.history(sessionId))
    return { conversation: toSummary(conversation), messages: messages.map(toMessage) }
  }

  async sendMessage(
    input: SendMessageInput,
    emit: ConversationEventListener
  ): Promise<SendMessageResult> {
    if (this.activeRequests.has(input.requestId)) {
      throw new Error('A request with this identifier is already active')
    }

    const controller = new AbortController()
    this.activeRequests.set(input.requestId, controller)

    try {
      const conversation = await this.withPersistence(() => this.repository.find(input.sessionId))
      if (!conversation) {
        throw new ConversationNotFoundError(input.sessionId)
      }
    } catch (error) {
      this.activeRequests.delete(input.requestId)
      throw error
    }

    void this.run(input, controller, emit)
    return { requestId: input.requestId, accepted: true }
  }

  cancelMessage(requestId: string): void {
    this.activeRequests.get(requestId)?.abort()
  }

  private async run(
    input: SendMessageInput,
    controller: AbortController,
    emit: ConversationEventListener
  ): Promise<void> {
    const eventBase = { requestId: input.requestId, sessionId: input.sessionId }

    try {
      emit({ ...eventBase, type: 'started' })

      const userMessage: StoredMessage = {
        id: randomUUID(),
        sessionId: input.sessionId,
        role: 'user',
        content: input.text,
        createdAt: new Date().toISOString()
      }
      await this.withPersistence(() => this.repository.appendMessage(userMessage))

      if (controller.signal.aborted) {
        emit({ ...eventBase, type: 'cancelled' })
        return
      }

      const history = await this.withPersistence(() => this.repository.history(input.sessionId))
      const modelMessages: ModelMessage[] = history.map(({ role, content }) => ({ role, content }))
      let response = ''

      for await (const delta of this.model.streamReply({
        messages: modelMessages,
        signal: controller.signal
      })) {
        if (controller.signal.aborted) break
        response += delta
        emit({ ...eventBase, type: 'chunk', delta })
        if (controller.signal.aborted) break
      }

      if (controller.signal.aborted) {
        emit({ ...eventBase, type: 'cancelled' })
        return
      }

      const assistantMessage: StoredMessage = {
        id: randomUUID(),
        sessionId: input.sessionId,
        role: 'assistant',
        content: response,
        createdAt: new Date().toISOString()
      }
      await this.withPersistence(() => this.repository.appendMessage(assistantMessage))
      emit({ ...eventBase, type: 'completed', messageId: assistantMessage.id })
    } catch (error) {
      if (controller.signal.aborted) {
        emit({ ...eventBase, type: 'cancelled' })
      } else {
        emit({
          ...eventBase,
          type: 'failed',
          error: this.toSafeError(error)
        })
      }
    } finally {
      this.activeRequests.delete(input.requestId)
    }
  }

  private async withPersistence<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (
        error instanceof ConversationPersistenceError ||
        error instanceof ConversationNotFoundError
      ) {
        throw error
      }
      throw new ConversationPersistenceError('Conversation repository operation failed', {
        cause: error
      })
    }
  }

  private toSafeError(error: unknown): {
    code: 'MODEL_ERROR' | 'PERSISTENCE_ERROR' | 'UNKNOWN_ERROR'
    message: string
  } {
    if (error instanceof ConversationPersistenceError) {
      return { code: 'PERSISTENCE_ERROR', message: '保存会话失败，请稍后重试。' }
    }

    if (error instanceof Error) {
      return { code: 'MODEL_ERROR', message: '生成回复失败，请稍后重试。' }
    }

    return { code: 'UNKNOWN_ERROR', message: '发生未知错误，请稍后重试。' }
  }
}

function toSummary(conversation: StoredConversation): ConversationSummary {
  return {
    sessionId: conversation.id,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt
  }
}

function toMessage(message: StoredMessage): ConversationMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt
  }
}

function byMostRecent(a: ConversationSummary, b: ConversationSummary): number {
  return (
    b.updatedAt.localeCompare(a.updatedAt) ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.sessionId.localeCompare(b.sessionId)
  )
}
