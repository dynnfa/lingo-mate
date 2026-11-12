import type {
  BusinessPort,
  BusinessRequest,
  BusinessResult
} from '../../core/communication/business-port'
import type { ConversationModule } from '../../core/conversation/conversation-module'
import {
  ConversationBusyError,
  RequestBusyError,
  type ConversationRepository
} from '../../core/conversation/conversation-repository'
import type { ConversationSkillRepository } from '../../core/conversation/conversation-skill-repository'
import { projectResult } from '../../core/communication/reply-projection'
import { createSentenceFeedbackFormatter } from '../sentence-feedback'

// A channel has no WebContents owner. Its service validates ownership before using this port.
export class ConversationBusinessPort implements BusinessPort {
  constructor(
    private readonly conversations: ConversationModule,
    private readonly repository: ConversationRepository & ConversationSkillRepository
  ) {}
  createSession(id: string, title: string): Promise<void> {
    return this.conversations.createPersistentConversation(id, title)
  }
  execute(input: BusinessRequest, signal: AbortSignal): Promise<BusinessResult> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      let settled = false
      const cancel = (): void => {
        try {
          this.cancel(input.requestId)
        } catch {
          /* registering */
        }
      }
      const done = (result: BusinessResult): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', cancel)
        resolve(result)
      }
      const emit: Parameters<ConversationModule['sendMessage']>[1] = (event) => {
        // Guard canonical identity on completion; never read current/last message.
        if (event.requestId !== input.requestId || event.sessionId !== input.sessionId) return
        if (event.type === 'started' && signal.aborted) cancel()
        if (event.type === 'completed' && event.message.messageId !== input.assistantMessageId)
          return
        const result = projectResult(event)
        if (result) done(result)
      }
      signal.addEventListener('abort', cancel, { once: true })
      const context = {
        operation: input.operation,
        languages: input.languages,
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId
      }
      const operation =
        input.operation === 'sentence'
          ? this.conversations.runSkill(
              {
                requestId: input.requestId,
                sessionId: input.sessionId,
                skillId: 'sentence',
                arguments: { text: input.text, wordLanguage: input.languages.targetLanguage }
              },
              emit,
              context
            )
          : this.conversations.sendMessage(
              { requestId: input.requestId, sessionId: input.sessionId, text: input.text },
              emit,
              context
            )
      void operation.then(
        () => {
          if (signal.aborted) cancel()
        },
        (error: unknown) => {
          signal.removeEventListener('abort', cancel)
          if (!settled) {
            settled = true
            if (error instanceof ConversationBusyError || error instanceof RequestBusyError)
              resolve({ status: 'failed' })
            else reject(error)
          }
        }
      )
    })
  }
  async recover(input: BusinessRequest): Promise<BusinessResult | undefined> {
    if (input.operation === 'sentence') {
      const execution = await this.repository.findExecutionByUserMessage(
        input.sessionId,
        input.userMessageId
      )
      if (execution?.skillId !== 'sentence' || execution.batch?.requestId !== input.requestId)
        return undefined
      return {
        status: 'succeeded',
        text: createSentenceFeedbackFormatter()(execution.batch, input.languages.outputLanguage)
      }
    }
    const history = await this.repository.history(input.sessionId)
    const user = history.find((m) => m.id === input.userMessageId && m.role === 'user')
    const assistant = history.find(
      (m) => m.id === input.assistantMessageId && m.role === 'assistant'
    )
    return user && assistant && !assistant.speech
      ? { status: 'succeeded', text: assistant.content }
      : undefined
  }
  cancel(requestId: string): void {
    this.conversations.cancelMessage(requestId)
  }
}
