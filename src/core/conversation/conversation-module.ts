import { randomUUID } from 'node:crypto'
import { classifyModelRequestError, ModelRequestError } from '../llm/llm-client'
import { conversationSummarySchema } from '../../shared/conversation'
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
import type { SupportedLocale, TargetLanguage } from '../../shared/preferences'
import type { LanguageModel, ModelMessage, ReplyPromptKind } from '../llm/language-model'
import { ModelConfigValidationError, ModelNotConfiguredError } from '../llm/model-config'
import { isWordConceptMessage } from '../prompt/word-concept'
import { VocabularyConversationSkill } from '../learning/vocabulary/vocabulary-conversation-skill'
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

// 一次执行的语言快照：解释语言跟随界面语言，目标语言来自独立配置。
// 在执行开始时解析一次，同一次执行内的模型调用、工具分析与反馈保持一致。
export interface ConversationLanguages {
  outputLanguage: SupportedLocale
  targetLanguage: TargetLanguage
}

// 客户端技能参数携带的 wordLanguage 与当前目标语言快照不一致：拒绝执行，
// 避免 Renderer 旧值与已生效设置冲突。
export class SkillLanguageMismatchError extends Error {
  constructor(
    readonly wordLanguage: string,
    readonly targetLanguage: string
  ) {
    super(`Skill word language ${wordLanguage} does not match target language ${targetLanguage}`)
    this.name = 'SkillLanguageMismatchError'
  }
}

// 一次运行期请求的全部身份：requestId 只用于事件关联与取消，
// user/assistant messageId 是消息在事件、Renderer 与 SQLite 中的唯一身份。
interface ActiveExecution {
  controller: AbortController
  sessionId: string
  userMessageId: string
  assistantMessageId: string
  languages: ConversationLanguages
}

type DraftConversation = Omit<StoredConversation, 'title'> & { title: null }

export class ConversationModule {
  private readonly drafts = new Map<string, DraftConversation>()
  private readonly activeRequests = new Map<string, ActiveExecution>()
  private readonly sessionRequests = new Map<string, string>()

  constructor(
    private readonly model: LanguageModel,
    private readonly repository: ConversationRepository,
    // 每次生成开始时解析当前语言配置并显式传给模型，语言切换不重建本模块。
    private readonly resolveLanguages: () => ConversationLanguages = () => ({
      outputLanguage: 'zh-CN',
      targetLanguage: 'en'
    }),
    private readonly vocabularySkill?: VocabularyConversationSkill,
    private readonly skillRepository?: ConversationSkillRepository
  ) {}

  async createConversation(): Promise<ConversationSummary> {
    const now = new Date().toISOString()
    const conversation: DraftConversation = {
      id: randomUUID(),
      title: null,
      createdAt: now,
      updatedAt: now
    }
    this.drafts.set(conversation.id, conversation)
    return toSummary(conversation)
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const conversations = await this.withPersistence(() => this.repository.list())
    return conversations.map(toSummary).sort(byMostRecent)
  }

  async loadConversation(sessionId: string): Promise<LoadedConversation> {
    const conversation =
      this.drafts.get(sessionId) ??
      (await this.withPersistence(() => this.repository.find(sessionId)))
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
    const conversation =
      this.drafts.get(input.sessionId) ??
      (await this.withPersistence(() => this.repository.find(input.sessionId)))
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
      assistantMessageId,
      languages: this.snapshotLanguages()
    })

    try {
      const titled = await this.prepareConversation(input.requestId, userMessage)
      if (titled) this.activeRequests.get(input.requestId)!.controller.signal.throwIfAborted()
      await this.withPersistence(() => this.repository.appendMessage(userMessage, titled))
      this.drafts.delete(input.sessionId)
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
    const conversation =
      this.drafts.get(input.sessionId) ??
      (await this.withPersistence(() => this.repository.find(input.sessionId)))
    if (!conversation) throw new ConversationNotFoundError(input.sessionId)

    // 技能执行的 wordLanguage 来源于目标语言快照；客户端传值与当前设置
    // 不一致时明确拒绝，不接受旧值静默执行。
    const languages = this.snapshotLanguages()
    if (input.arguments.wordLanguage !== languages.targetLanguage) {
      throw new SkillLanguageMismatchError(input.arguments.wordLanguage, languages.targetLanguage)
    }
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
      explanationLanguage: languages.outputLanguage,
      phase: 'started',
      createdAt: now,
      updatedAt: now
    }
    const assistantMessageId = randomUUID()
    this.registerExecution(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId,
      languages
    })

    try {
      const titled = await this.prepareConversation(input.requestId, userMessage)
      if (titled) this.activeRequests.get(input.requestId)!.controller.signal.throwIfAborted()
      await this.withPersistence(() =>
        this.skillRepository!.createExecution(execution, userMessage, titled)
      )
      this.drafts.delete(input.sessionId)
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
      // 已持久化的技能重试沿用原执行参数和解释语言；不读取当前设置。
      this.registerExecution(input.requestId, {
        controller: new AbortController(),
        sessionId: input.sessionId,
        userMessageId: userMessage.id,
        assistantMessageId,
        languages: {
          outputLanguage: skillExecution.explanationLanguage,
          targetLanguage: skillExecution.arguments.wordLanguage
        }
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
        void this.retryVocabularyReply(
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
    // 普通回复重试视为新执行，读取当前语言设置。
    this.registerExecution(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId,
      languages: this.snapshotLanguages()
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

  // 标题完整生成并校验后才把会话交给仓库；仓库与首条消息原子提交。
  private async prepareConversation(
    requestId: string,
    message: StoredMessage
  ): Promise<StoredConversation | undefined> {
    const draft = this.drafts.get(message.sessionId)
    if (!draft) return undefined
    const active = this.activeRequests.get(requestId)!
    const signal = active.controller.signal
    let title = ''
    try {
      for await (const delta of this.model.streamReply({
        messages: [{ role: 'user', content: message.content }],
        ...active.languages,
        promptKind: 'conversation-title',
        signal
      })) {
        signal.throwIfAborted()
        title += delta
        if (title.length > 160)
          throw new ModelRequestError('PROTOCOL', new Error('Title is too long'))
      }
    } catch (error) {
      signal.throwIfAborted()
      if (
        error instanceof ModelNotConfiguredError ||
        error instanceof ModelConfigValidationError ||
        error instanceof ModelRequestError
      )
        throw error
      throw new ModelRequestError(classifyModelRequestError(error), error)
    }
    signal.throwIfAborted()
    const parsed = conversationSummarySchema.shape.title.unwrap().safeParse(title)
    if (!parsed.success || /[\r\n]/.test(parsed.data)) {
      throw new ModelRequestError('PROTOCOL', new Error('Invalid conversation title'))
    }
    return {
      ...draft,
      title: parsed.data,
      createdAt: message.createdAt,
      updatedAt: message.createdAt
    }
  }

  // 快照只拷贝原始值，不持有 resolver 返回的对象：执行期间设置源变化
  // 不会泄漏进已建立的快照。
  private snapshotLanguages(): ConversationLanguages {
    const { outputLanguage, targetLanguage } = this.resolveLanguages()
    return { outputLanguage, targetLanguage }
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
    this.drafts.clear()
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
      // 本次回复面向会话最后一条消息；仅当它是用户的 /concept 命令消息时
      // 切换到概念讲解提示词。命令保留在原始消息里，重试路径据此重新应用。
      const answered = history.at(-1)
      const promptKind: ReplyPromptKind =
        answered?.role === 'user' && isWordConceptMessage(answered.content)
          ? 'word-concept'
          : 'conversation'
      let response = ''

      for await (const delta of this.model.streamReply({
        messages: modelMessages,
        outputLanguage: execution.languages.outputLanguage,
        // 目标语言来自执行开始时的配置快照，不随界面语言切换。
        targetLanguage: execution.languages.targetLanguage,
        promptKind,
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
      await this.persistSkillReply(generation, skillExecution, result.batch, emit)
    } catch (error) {
      if (execution.controller.signal.aborted) {
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

  // 恢复流程只依据已持久化报告生成本地反馈：不再次调用模型，也不再次写词库。
  private async retryVocabularyReply(
    generation: GenerationStarted,
    skillExecution: StoredConversationSkillExecution,
    batch: NonNullable<StoredConversationSkillExecution['batch']>,
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
      await this.skillRepository!.setExecutionPhase(skillExecution.id, 'summarizing')
      emit({ ...eventBase, type: 'skillPhase', phase: 'summarizing' })
      await this.persistSkillReply(generation, skillExecution, batch, emit)
    } catch (error) {
      emit({
        ...eventBase,
        type: 'failed',
        messageId: assistantMessageId,
        error: this.toSafeError(error)
      })
    } finally {
      this.releaseExecution(requestId)
    }
  }

  private async persistSkillReply(
    generation: GenerationStarted,
    skillExecution: StoredConversationSkillExecution,
    batch: NonNullable<StoredConversationSkillExecution['batch']>,
    emit: ConversationEventListener
  ): Promise<void> {
    const feedback = this.vocabularySkill!.feedback(batch, skillExecution.explanationLanguage)
    const assistantMessage: StoredMessage = {
      id: generation.assistantMessageId,
      sessionId: generation.sessionId,
      role: 'assistant',
      content: feedback,
      createdAt: new Date().toISOString()
    }
    await this.withPersistence(() =>
      this.skillRepository!.finishExecution(skillExecution.id, 'completed', assistantMessage)
    )
    emit({
      requestId: generation.requestId,
      sessionId: generation.sessionId,
      type: 'completed',
      message: toMessage(assistantMessage),
      skillCompletion: 'complete'
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

    if (error instanceof VocabularyError && error.code === 'TOOL_CALL_NOT_SUPPORTED') {
      return { code: 'TOOL_CALL_NOT_SUPPORTED' }
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

function toSummary(conversation: StoredConversation | DraftConversation): ConversationSummary {
  return {
    sessionId: conversation.id,
    title: conversation.title,
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
