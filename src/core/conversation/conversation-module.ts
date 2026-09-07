import { randomUUID } from 'node:crypto'
import type {
  ConversationEvent,
  ConversationMessage,
  ConversationSummary,
  GenerationAccepted,
  GenerationEventError,
  GenerationStarted,
  LoadedConversation,
  RetryMessageInput,
  RunConversationSkillInput,
  SendMessageInput
} from '../../shared/conversation'
import { runConversationSkillInputSchema } from '../../shared/conversation'
import type { LanguageModel, ModelMessage } from '../llm/language-model'
import { ModelConfigValidationError, ModelNotConfiguredError } from '../llm/model-config'
import {
  VocabularyDescriptionError,
  type VocabularyConversationSkill
} from '../learning/vocabulary/vocabulary-conversation-skill'
import { deterministicVocabularyFacts } from '../learning/vocabulary/vocabulary-result-describer'
import { VocabularyError } from '../learning/vocabulary/parse-vocabulary-input'
import type {
  ConversationSkillRepository,
  StoredConversationSkillExecution
} from './conversation-skill-repository'
import {
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationPersistenceError,
  MessageNotFoundError,
  RequestBusyError,
  RequestNotFoundError,
  RetryNotAllowedError,
  type ConversationRepository,
  type StoredConversation,
  type StoredMessage
} from './conversation-repository'

export type ConversationEventListener = (event: ConversationEvent) => void

// 一次运行期请求的全部身份：requestId 只用于事件关联与取消，
// user/assistant messageId 是消息在事件、Renderer 与 SQLite 中的唯一身份。
interface ActiveExecution {
  controller: AbortController
  sessionId: string
  userMessageId: string
  assistantMessageId: string
}

export class ConversationModule {
  private readonly activeRequests = new Map<string, ActiveExecution>()
  private readonly sessionRequests = new Map<string, string>()

  constructor(
    private readonly model: LanguageModel,
    private readonly repository: ConversationRepository,
    // 每次生成开始时解析当前界面语言并显式传给模型，语言切换不重建本模块。
    private readonly resolveOutputLanguage: () => 'zh-CN' | 'en' = () => 'zh-CN',
    private readonly vocabularySkill?: VocabularyConversationSkill,
    private readonly skillRepository?: ConversationSkillRepository
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
  ): Promise<GenerationAccepted> {
    const conversation = await this.withPersistence(() => this.repository.find(input.sessionId))
    if (!conversation) {
      throw new ConversationNotFoundError(input.sessionId)
    }

    const userMessage: StoredMessage = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: 'user',
      content: input.text,
      createdAt: new Date().toISOString()
    }
    const assistantMessageId = randomUUID()
    this.registerExecution(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId
    })

    try {
      await this.withPersistence(() => this.repository.appendMessage(userMessage))
    } catch (error) {
      // user 消息未持久化：不得发 started，也不得让 UI 出现伪消息。
      this.releaseExecution(input.requestId)
      emit({
        type: 'failed',
        requestId: input.requestId,
        sessionId: input.sessionId,
        error: this.toSafeError(error)
      })
      throw error
    }

    const generation: GenerationStarted = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: toMessage(userMessage),
      assistantMessageId
    }
    return this.launchGeneration(generation, emit)
  }

  async runSkill(
    input: RunConversationSkillInput,
    emit: ConversationEventListener
  ): Promise<GenerationAccepted> {
    runConversationSkillInputSchema.parse(input)
    if (!this.vocabularySkill || !this.skillRepository) {
      throw new Error('Conversation skills are not configured')
    }
    const conversation = await this.withPersistence(() => this.repository.find(input.sessionId))
    if (!conversation) throw new ConversationNotFoundError(input.sessionId)

    const now = new Date().toISOString()
    const userMessage: StoredMessage = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: 'user',
      content: `/vocabulary ${input.arguments.text}`,
      createdAt: now
    }
    const execution: StoredConversationSkillExecution = {
      id: randomUUID(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      skillId: 'vocabulary',
      arguments: input.arguments,
      explanationLanguage: this.resolveOutputLanguage(),
      phase: 'started',
      createdAt: now,
      updatedAt: now
    }
    const assistantMessageId = randomUUID()
    this.registerExecution(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId
    })

    try {
      await this.withPersistence(() =>
        this.skillRepository!.createExecution(execution, userMessage)
      )
    } catch (error) {
      this.releaseExecution(input.requestId)
      emit({
        type: 'failed',
        requestId: input.requestId,
        sessionId: input.sessionId,
        error: this.toSafeError(error)
      })
      throw error
    }

    const generation: GenerationStarted = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: toMessage(userMessage),
      assistantMessageId
    }
    const active = this.activeRequests.get(input.requestId)
    if (!active) throw new Error('Skill execution is not registered')
    void this.runVocabularySkill(generation, execution, active, emit)
    return { accepted: true, generation }
  }

  async retryMessage(
    input: RetryMessageInput,
    emit: ConversationEventListener
  ): Promise<GenerationAccepted> {
    const conversation = await this.withPersistence(() => this.repository.find(input.sessionId))
    if (!conversation) {
      throw new ConversationNotFoundError(input.sessionId)
    }

    const history = await this.withPersistence(() => this.repository.history(input.sessionId))
    const userMessage = history.find(
      (message) => message.id === input.userMessageId && message.sessionId === input.sessionId
    )
    if (!userMessage || userMessage.role !== 'user') {
      throw new MessageNotFoundError(input.userMessageId)
    }

    const skillExecution = this.skillRepository
      ? await this.withPersistence(() =>
          this.skillRepository!.findExecutionByUserMessage(input.sessionId, input.userMessageId)
        )
      : undefined

    if (skillExecution) {
      if (!this.vocabularySkill || skillExecution.phase === 'completed') {
        throw new RetryNotAllowedError('skill execution cannot be retried')
      }
      const assistantMessageId = randomUUID()
      this.registerExecution(input.requestId, {
        controller: new AbortController(),
        sessionId: input.sessionId,
        userMessageId: userMessage.id,
        assistantMessageId
      })
      const generation: GenerationStarted = {
        requestId: input.requestId,
        sessionId: input.sessionId,
        userMessage: toMessage({ ...userMessage, retryable: false }),
        assistantMessageId
      }
      const active = this.activeRequests.get(input.requestId)
      if (!active) throw new Error('Skill retry is not registered')
      if (skillExecution.batch) {
        void this.retryVocabularyDescription(
          generation,
          skillExecution,
          skillExecution.batch,
          active,
          emit
        )
      } else {
        void this.runVocabularySkill(generation, skillExecution, active, emit)
      }
      return { accepted: true, generation }
    }

    const lastMessage = history.at(-1)
    if (!lastMessage || lastMessage.id !== userMessage.id) {
      throw new RetryNotAllowedError('only the last unanswered user message can be retried')
    }

    const assistantMessageId = randomUUID()
    this.registerExecution(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId
    })

    const generation: GenerationStarted = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: toMessage(userMessage),
      assistantMessageId
    }
    return this.launchGeneration(generation, emit)
  }

  cancelMessage(requestId: string): void {
    const execution = this.activeRequests.get(requestId)
    if (!execution) {
      throw new RequestNotFoundError(requestId)
    }
    execution.controller.abort()
  }

  private registerExecution(requestId: string, execution: ActiveExecution): void {
    if (this.activeRequests.has(requestId)) {
      throw new RequestBusyError(requestId)
    }

    const runningRequestId = this.sessionRequests.get(execution.sessionId)
    if (runningRequestId && this.activeRequests.has(runningRequestId)) {
      throw new ConversationBusyError(execution.sessionId)
    }

    this.activeRequests.set(requestId, execution)
    this.sessionRequests.set(execution.sessionId, requestId)
  }

  private launchGeneration(
    generation: GenerationStarted,
    emit: ConversationEventListener
  ): GenerationAccepted {
    const execution = this.activeRequests.get(generation.requestId)
    if (!execution) {
      throw new Error('Generation execution is not registered')
    }

    void this.runGeneration(generation, execution, emit)
    return { accepted: true, generation }
  }

  dispose(): void {
    for (const execution of this.activeRequests.values()) execution.controller.abort()
  }

  private async runGeneration(
    generation: GenerationStarted,
    execution: ActiveExecution,
    emit: ConversationEventListener
  ): Promise<void> {
    const { requestId, sessionId, assistantMessageId } = generation
    const eventBase = { requestId, sessionId }

    try {
      // started 的语义：user 消息已持久化、canonical 生成身份已建立。
      emit({ type: 'started', ...generation })

      // 取消发生在 user append 期间：append 完成后仍先发 started 再发 cancelled，
      // 使 UI 与数据库中已存在的 user 消息保持一致。
      if (execution.controller.signal.aborted) {
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }

      const history = await this.withPersistence(() => this.repository.history(sessionId))
      const modelMessages: ModelMessage[] = history.map(({ role, content }) => ({ role, content }))
      let response = ''

      for await (const delta of this.model.streamReply({
        messages: modelMessages,
        outputLanguage: this.resolveOutputLanguage(),
        // 首版默认英语练习；学习语言不随界面语言切换。
        targetLanguage: 'en',
        signal: execution.controller.signal
      })) {
        if (execution.controller.signal.aborted) break
        response += delta
        emit({ ...eventBase, type: 'chunk', messageId: assistantMessageId, delta })
        if (execution.controller.signal.aborted) break
      }

      if (execution.controller.signal.aborted) {
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }

      const assistantMessage: StoredMessage = {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        content: response,
        createdAt: new Date().toISOString()
      }
      await this.withPersistence(() => this.repository.appendMessage(assistantMessage))
      emit({ ...eventBase, type: 'completed', message: toMessage(assistantMessage) })
    } catch (error) {
      if (execution.controller.signal.aborted) {
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
      } else {
        emit({
          ...eventBase,
          type: 'failed',
          messageId: assistantMessageId,
          error: this.toSafeError(error)
        })
      }
    } finally {
      this.releaseExecution(requestId)
    }
  }

  private async runVocabularySkill(
    generation: GenerationStarted,
    skillExecution: StoredConversationSkillExecution,
    execution: ActiveExecution,
    emit: ConversationEventListener
  ): Promise<void> {
    const { requestId, sessionId, assistantMessageId } = generation
    const eventBase = { requestId, sessionId }
    try {
      emit({ type: 'started', ...generation })
      if (execution.controller.signal.aborted) {
        await this.skillRepository!.setExecutionPhase(skillExecution.id, 'cancelled')
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }

      const result = await this.vocabularySkill!.run({
        requestId,
        executionId: skillExecution.id,
        arguments: skillExecution.arguments,
        explanationLanguage: skillExecution.explanationLanguage,
        signal: execution.controller.signal,
        onPhase: async (phase) => {
          await this.skillRepository!.setExecutionPhase(skillExecution.id, phase)
          emit({ ...eventBase, type: 'skillPhase', phase })
        }
      })

      if (result.batch.outcome === 'cancelled') {
        await this.skillRepository!.setExecutionPhase(skillExecution.id, 'cancelled')
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }
      await this.persistSkillReply(
        generation,
        skillExecution,
        result.batch,
        result.description,
        'completed',
        emit
      )
    } catch (error) {
      if (error instanceof VocabularyDescriptionError) {
        try {
          await this.persistSkillReply(
            generation,
            skillExecution,
            error.batch,
            '',
            execution.controller.signal.aborted ? 'description_cancelled' : 'description_failed',
            emit
          )
        } catch (persistenceError) {
          emit({
            ...eventBase,
            type: 'failed',
            messageId: assistantMessageId,
            error: this.toSafeError(persistenceError)
          })
        }
      } else if (execution.controller.signal.aborted) {
        try {
          await this.skillRepository!.setExecutionPhase(skillExecution.id, 'cancelled')
          emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        } catch (persistenceError) {
          emit({
            ...eventBase,
            type: 'failed',
            messageId: assistantMessageId,
            error: this.toSafeError(persistenceError)
          })
        }
      } else {
        try {
          await this.skillRepository!.setExecutionPhase(skillExecution.id, 'failed')
        } catch {
          // The original safe error is more useful than a secondary phase update failure.
        }
        emit({
          ...eventBase,
          type: 'failed',
          messageId: assistantMessageId,
          error: this.toSafeError(error)
        })
      }
    } finally {
      this.releaseExecution(requestId)
    }
  }

  private async retryVocabularyDescription(
    generation: GenerationStarted,
    skillExecution: StoredConversationSkillExecution,
    batch: NonNullable<StoredConversationSkillExecution['batch']>,
    execution: ActiveExecution,
    emit: ConversationEventListener
  ): Promise<void> {
    const { requestId, sessionId } = generation
    const eventBase = { requestId, sessionId }
    try {
      emit({ type: 'started', ...generation })
      const description = await this.vocabularySkill!.describe(
        batch,
        skillExecution.explanationLanguage,
        execution.controller.signal,
        async () => {
          await this.skillRepository!.setExecutionPhase(skillExecution.id, 'summarizing')
          emit({ ...eventBase, type: 'skillPhase', phase: 'summarizing' })
        }
      )
      await this.persistSkillReply(
        generation,
        skillExecution,
        batch,
        description,
        'completed',
        emit
      )
    } catch (error) {
      try {
        await this.persistSkillReply(
          generation,
          skillExecution,
          batch,
          '',
          execution.controller.signal.aborted ? 'description_cancelled' : 'description_failed',
          emit
        )
      } catch (persistenceError) {
        emit({
          ...eventBase,
          type: 'failed',
          messageId: generation.assistantMessageId,
          error: this.toSafeError(persistenceError ?? error)
        })
      }
    } finally {
      this.releaseExecution(requestId)
    }
  }

  private async persistSkillReply(
    generation: GenerationStarted,
    skillExecution: StoredConversationSkillExecution,
    batch: NonNullable<StoredConversationSkillExecution['batch']>,
    description: string,
    phase: 'completed' | 'description_failed' | 'description_cancelled',
    emit: ConversationEventListener
  ): Promise<void> {
    const fallback =
      skillExecution.explanationLanguage === 'zh-CN'
        ? phase === 'description_cancelled'
          ? '词汇处理已完成，结果描述已取消。'
          : '词汇处理已完成，但结果描述失败。'
        : phase === 'description_cancelled'
          ? 'Vocabulary processing completed, but the result description was cancelled.'
          : 'Vocabulary processing completed, but the result description failed.'
    const facts = deterministicVocabularyFacts(batch, skillExecution.explanationLanguage)
    const assistantMessage: StoredMessage = {
      id: generation.assistantMessageId,
      sessionId: generation.sessionId,
      role: 'assistant',
      content: `${description || fallback}\n\n${facts}`,
      createdAt: new Date().toISOString()
    }
    await this.withPersistence(() =>
      this.skillRepository!.finishExecution(skillExecution.id, phase, assistantMessage)
    )
    emit({
      requestId: generation.requestId,
      sessionId: generation.sessionId,
      type: 'completed',
      message: toMessage(assistantMessage),
      skillCompletion:
        phase === 'completed'
          ? 'complete'
          : phase === 'description_cancelled'
            ? 'description_cancelled'
            : 'description_failed',
      ...(phase === 'completed' ? {} : { retryableUserMessageId: skillExecution.userMessageId })
    })
  }

  private releaseExecution(requestId: string): void {
    const execution = this.activeRequests.get(requestId)
    this.activeRequests.delete(requestId)
    if (execution && this.sessionRequests.get(execution.sessionId) === requestId) {
      this.sessionRequests.delete(execution.sessionId)
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

  // Core 只返回安全错误码，不负责界面翻译；内部原因留在产生处。
  private toSafeError(error: unknown): GenerationEventError {
    if (error instanceof ConversationPersistenceError) {
      return { code: 'PERSISTENCE_ERROR' }
    }

    if (error instanceof VocabularyError && error.code === 'STORAGE_FAILED') {
      return { code: 'PERSISTENCE_ERROR' }
    }

    if (error instanceof ModelConfigValidationError && error.code === 'CREDENTIAL_DECRYPT_FAILED') {
      return { code: 'CREDENTIAL_DECRYPT_FAILED' }
    }

    if (error instanceof ModelNotConfiguredError) {
      return { code: 'MODEL_NOT_CONFIGURED' }
    }

    if (error instanceof Error) {
      return { code: 'MODEL_ERROR' }
    }

    return { code: 'UNKNOWN_ERROR' }
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
    messageId: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(message.retryable === true ? { retryable: true } : {})
  }
}

function byMostRecent(a: ConversationSummary, b: ConversationSummary): number {
  return (
    b.updatedAt.localeCompare(a.updatedAt) ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.sessionId.localeCompare(b.sessionId)
  )
}
