import { randomUUID } from 'node:crypto'
import type { ConversationEvent, SendMessageInput } from '../../shared/conversation'
import type { LanguageModel, ModelMessage, ModelRole } from '../llm/language-model'

export interface StoredMessage {
  id: string
  sessionId: string
  role: ModelRole
  content: string
  createdAt: string
}

export interface ConversationStore {
  append(message: StoredMessage): Promise<void>
  history(sessionId: string): Promise<StoredMessage[]>
}

export type ConversationEventListener = (event: ConversationEvent) => void

export class ConversationSession {
  private readonly activeRequests = new Map<string, AbortController>()

  constructor(
    private readonly model: LanguageModel,
    private readonly store: ConversationStore
  ) {}

  start(input: SendMessageInput, emit: ConversationEventListener): void {
    if (this.activeRequests.has(input.requestId)) {
      throw new Error('A request with this identifier is already active')
    }

    const controller = new AbortController()
    this.activeRequests.set(input.requestId, controller)
    void this.run(input, controller, emit)
  }

  cancel(requestId: string): void {
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
      await this.store.append(userMessage)

      if (controller.signal.aborted) {
        emit({ ...eventBase, type: 'cancelled' })
        return
      }

      const history = await this.store.history(input.sessionId)
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
      await this.store.append(assistantMessage)
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

export class ConversationPersistenceError extends Error {}
