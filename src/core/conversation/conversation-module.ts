import { SpeechError } from '../speech/speech-synthesizer'
import { speechInputSchema } from '../../shared/speech'
import { splitConversationCommand } from '../../shared/conversation-command'
import { AgentRuntimeError, type AgentRuntime } from '../agent/agent-runtime'
import { noopCoreDiagnostics, type CoreDiagnostics } from '../error-diagnostics'
import { parsePhraseInput } from '../learning/phrase/parse-phrase-input'
import { parseVocabularyInput } from '../learning/vocabulary/parse-vocabulary-input'
import { parseSynonymInput } from '../learning/synonym/parse-synonym-input'
import { randomUUID } from 'node:crypto'
import { classifyModelRequestError, ModelRequestError } from '../llm/llm-client'
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  conversationSummarySchema,
  sendMessageInputSchema,
  type ConversationSkillId
} from '../../shared/conversation'
import type {
  ConversationSummary,
  GenerationAccepted,
  GenerationStarted,
  LoadedConversation,
  RetryMessageInput,
  RunConversationSkillInput,
  SendMessageInput
} from '../../shared/conversation'
import { SUPPORTED_LOCALES, targetLanguageSchema } from '../../shared/preferences'
import { runConversationSkillInputSchema } from '../../shared/conversation'
import type { ModelMessage } from '../llm/language-model'
import { ModelConfigValidationError, ModelNotConfiguredError } from '../llm/model-config'
import type { ConversationSkill } from './conversation-skill'
import type { ConversationSkillRepository } from './conversation-skill-repository'
import {
  ConversationNotFoundError,
  ConversationPersistenceError,
  MessageNotFoundError,
  RetryNotAllowedError,
  type ConversationRepository,
  type StoredConversation,
  type StoredMessage
} from './conversation-repository'
import {
  ConversationExecutions,
  type ActiveExecution,
  type ConversationEventListener,
  type ConversationLanguages
} from './conversation-execution'
import {
  reportConversationFailure,
  toConversationEventError,
  withConversationPersistence
} from './conversation-errors'
import { toConversationMessage } from './conversation-message'
import {
  ExploreConversationExecution,
  exploreReplyId,
  fileResultSkillByCommand
} from './explore-conversation-execution'
import { StoredConversationSkillRunner } from './stored-conversation-skill-runner'

export type { ConversationEventListener, ConversationLanguages } from './conversation-execution'

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

// Trusted callers may supply canonical message IDs and an independent language
// snapshot. Renderer payloads cannot set this context.
export interface ConversationExecutionContext {
  operation: 'chat' | 'sentence'
  languages: ConversationLanguages
  userMessageId: string
  assistantMessageId: string
}

export class InvalidConversationCommandError extends Error {
  readonly code = 'INVALID_INPUT'
}

type ReplyTask = 'conversation' | 'concept'
type DraftConversation = Omit<StoredConversation, 'title'> & { title: null }

export class ConversationModule {
  private readonly drafts = new Map<string, DraftConversation>()
  private readonly executions = new ConversationExecutions()
  private readonly exploreExecutions: ExploreConversationExecution
  private readonly storedSkills: StoredConversationSkillRunner | undefined

  constructor(
    private readonly repository: ConversationRepository,
    private readonly agentRuntime: AgentRuntime,
    // 每次生成开始时解析当前语言配置并显式传给模型，语言切换不重建本模块。
    private readonly resolveLanguages: () => ConversationLanguages = () => ({
      outputLanguage: 'zh-CN',
      targetLanguage: 'en'
    }),
    // 会话技能按 skillId 注册与分派；新增技能时扩展 ConversationSkill 实现。
    private readonly skills: ReadonlyMap<ConversationSkillId, ConversationSkill> = new Map(),
    skillRepository?: ConversationSkillRepository,
    private readonly diagnostics: CoreDiagnostics = noopCoreDiagnostics
  ) {
    this.exploreExecutions = new ExploreConversationExecution(
      repository,
      skills,
      this.executions,
      diagnostics
    )
    this.storedSkills = skillRepository
      ? new StoredConversationSkillRunner(skillRepository, skills, this.executions, diagnostics)
      : undefined
  }

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

  async createPersistentConversation(sessionId: string, title: string): Promise<void> {
    const now = new Date().toISOString()
    if (await withConversationPersistence(() => this.repository.find(sessionId))) return
    const parsed = conversationSummarySchema.parse({
      sessionId,
      title,
      createdAt: now,
      updatedAt: now
    })
    await withConversationPersistence(() =>
      this.repository.create({
        id: sessionId,
        title: parsed.title!,
        createdAt: now,
        updatedAt: now
      })
    )
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const conversations = await withConversationPersistence(() => this.repository.list())
    return conversations.map(toSummary).sort(byMostRecent)
  }

  async loadConversation(sessionId: string): Promise<LoadedConversation> {
    const conversation =
      this.drafts.get(sessionId) ??
      (await withConversationPersistence(() => this.repository.find(sessionId)))
    if (!conversation) {
      throw new ConversationNotFoundError(sessionId)
    }

    const messages = await withConversationPersistence(() => this.repository.history(sessionId))
    const visibleMessages = await this.exploreExecutions.loadMessages(messages)
    return { conversation: toSummary(conversation), messages: visibleMessages }
  }

  async sendMessage(
    input: SendMessageInput,
    emit: ConversationEventListener,
    context?: ConversationExecutionContext
  ): Promise<GenerationAccepted> {
    sendMessageInputSchema.parse(input)
    return this.submit(input, emit, context)
  }

  async runSkill(
    input: RunConversationSkillInput,
    emit: ConversationEventListener,
    context?: ConversationExecutionContext
  ): Promise<GenerationAccepted> {
    const { requestId, sessionId, skillId, arguments: args } = input
    const suffix = 'text' in args ? ` ${args.text}` : ''
    return this.submit({ requestId, sessionId, text: `/${skillId}${suffix}` }, emit, context, input)
  }

  private async submit(
    input: SendMessageInput,
    emit: ConversationEventListener,
    context?: ConversationExecutionContext,
    compatibleSkill?: RunConversationSkillInput
  ): Promise<GenerationAccepted> {
    const { requestId, sessionId, text } = input
    const operation = context?.operation
    const languages = this.snapshotLanguages(context?.languages)
    const controller = new AbortController()
    const active = {
      controller,
      sessionId,
      userMessageId: context?.userMessageId ?? randomUUID(),
      assistantMessageId: context?.assistantMessageId ?? randomUUID(),
      languages
    }
    this.executions.register(requestId, active)

    try {
      const conversation =
        this.drafts.get(sessionId) ??
        (await withConversationPersistence(() => this.repository.find(sessionId)))
      controller.signal.throwIfAborted()
      if (!conversation) throw new ConversationNotFoundError(sessionId)

      const route = await this.agentRuntime.routeConversation({
        mode:
          operation === 'sentence'
            ? 'channel-sentence'
            : operation === 'chat'
              ? 'channel-chat'
              : 'desktop',
        text,
        ...languages,
        signal: controller.signal
      })
      controller.signal.throwIfAborted()

      if (route.kind === 'invalid') {
        if (route.workflow === 'tts') throw new SpeechError('INVALID_INPUT')
        throw new InvalidConversationCommandError()
      }
      if (
        (compatibleSkill &&
          (route.kind !== 'workflow' || route.workflow !== compatibleSkill.skillId)) ||
        (operation === 'sentence' &&
          (route.kind !== 'workflow' || route.workflow !== 'sentence')) ||
        (operation === 'chat' && route.kind !== 'reply')
      )
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')

      const userMessage: StoredMessage = {
        id: active.userMessageId,
        sessionId,
        role: 'user',
        content: text,
        createdAt: new Date().toISOString()
      }

      if (route.kind === 'workflow' && route.workflow !== 'concept') {
        const command = splitConversationCommand(text)
        if (command?.command !== route.workflow) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        const skillInput = this.bindSkill(
          input,
          route.workflow,
          command.body,
          languages,
          compatibleSkill
        )
        return await this.launchSkill(skillInput, userMessage, active, emit)
      }

      const titled = this.prepareConversation(userMessage)
      await this.saveUserMessage(userMessage, titled)
      if (titled) void this.updateTitle(requestId, userMessage, emit)
      const generation = this.generation(requestId, userMessage, active)
      return this.launchGeneration(
        generation,
        emit,
        route.kind === 'workflow' ? 'concept' : 'conversation'
      )
    } catch (error) {
      this.executions.release(requestId, active)
      if (controller.signal.aborted) {
        emit({ type: 'cancelled', requestId, sessionId, messageId: active.assistantMessageId })
        controller.signal.throwIfAborted()
      }
      if (error instanceof AgentRuntimeError || error instanceof ModelRequestError)
        reportConversationFailure(this.diagnostics, 'route-request', requestId, error)
      if (
        error instanceof AgentRuntimeError ||
        error instanceof ModelRequestError ||
        error instanceof ModelNotConfiguredError ||
        error instanceof ModelConfigValidationError ||
        error instanceof ConversationPersistenceError
      )
        emit({ type: 'failed', requestId, sessionId, error: toConversationEventError(error) })
      throw error
    }
  }

  private bindSkill(
    input: SendMessageInput,
    skillId: ConversationSkillId,
    body: string,
    languages: ConversationLanguages,
    compatibleSkill?: RunConversationSkillInput
  ): RunConversationSkillInput {
    const wordLanguage = languages.targetLanguage
    if (compatibleSkill && compatibleSkill.arguments.wordLanguage !== wordLanguage)
      throw new SkillLanguageMismatchError(compatibleSkill.arguments.wordLanguage, wordLanguage)
    const text = skillId === 'tts' || compatibleSkill ? body : body.trim()
    if (skillId === 'vocabulary') parseVocabularyInput(text)
    if (skillId === 'phrase') parsePhraseInput(text)
    if (skillId === 'synonym') parseSynonymInput(text)
    if (
      skillId === 'tts' &&
      !speechInputSchema.safeParse({
        requestId: input.requestId,
        text,
        language: wordLanguage
      }).success
    )
      throw new SpeechError('INVALID_INPUT')
    return runConversationSkillInputSchema.parse({
      requestId: input.requestId,
      sessionId: input.sessionId,
      skillId,
      arguments:
        skillId === 'explore-phrase' || skillId === 'explore-vocabulary'
          ? { wordLanguage }
          : { text, wordLanguage }
    })
  }

  private async launchSkill(
    input: RunConversationSkillInput,
    userMessage: StoredMessage,
    active: ActiveExecution,
    emit: ConversationEventListener
  ): Promise<GenerationAccepted> {
    const { requestId, sessionId, skillId } = input
    const skill = this.skills.get(skillId)
    if (!skill) throw new AgentRuntimeError('AGENT_UNAVAILABLE')
    const body = 'text' in input.arguments ? input.arguments.text : undefined
    userMessage.content = body === undefined ? `/${skillId}` : `/${skillId} ${body}`
    const titled = this.prepareConversation(userMessage, skillId === 'tts' ? body : undefined)
    active.controller.signal.throwIfAborted()

    if (skillId === 'explore-phrase' || skillId === 'explore-vocabulary') {
      active.assistantMessageId = exploreReplyId(skillId, userMessage.id)
      await this.saveUserMessage(userMessage, titled)
      if (titled) void this.updateTitle(requestId, userMessage, emit)
      const generation = this.generation(requestId, userMessage, active)
      void this.exploreExecutions.run(generation, randomUUID(), input, skill, active, emit)
      return { accepted: true, generation }
    }

    if (!this.storedSkills) throw new AgentRuntimeError('AGENT_UNAVAILABLE')
    const execution = await this.storedSkills.create(input, userMessage, active.languages, titled)
    this.drafts.delete(sessionId)
    if (titled && skillId !== 'tts') void this.updateTitle(requestId, userMessage, emit)
    const generation = this.generation(requestId, userMessage, active)
    void this.storedSkills.run(generation, execution, skill, active, emit)
    return { accepted: true, generation }
  }

  private async saveUserMessage(
    message: StoredMessage,
    titled: StoredConversation | undefined
  ): Promise<void> {
    await withConversationPersistence(() => this.repository.appendMessage(message, titled))
    this.drafts.delete(message.sessionId)
  }

  private generation(
    requestId: string,
    message: StoredMessage,
    active: ActiveExecution
  ): GenerationStarted {
    return {
      requestId,
      sessionId: message.sessionId,
      userMessage: toConversationMessage(message),
      assistantMessageId: active.assistantMessageId
    }
  }

  async retryMessage(
    input: RetryMessageInput,
    emit: ConversationEventListener
  ): Promise<GenerationAccepted> {
    const conversation = await withConversationPersistence(() =>
      this.repository.find(input.sessionId)
    )
    if (!conversation) {
      throw new ConversationNotFoundError(input.sessionId)
    }

    const history = await withConversationPersistence(() =>
      this.repository.history(input.sessionId)
    )
    const userMessage = history.find(
      (message) => message.id === input.userMessageId && message.sessionId === input.sessionId
    )
    if (!userMessage || userMessage.role !== 'user') {
      throw new MessageNotFoundError(input.userMessageId)
    }

    const skillRetry = await this.storedSkills?.retry(input, userMessage, emit)
    if (skillRetry) return skillRetry

    // File-backed exploration recovery uses saved replies/batches first. Only a
    // known uncommitted execution from this process may run the model again.
    const fileSkillId = fileResultSkillByCommand(userMessage.content)
    if (fileSkillId) {
      return this.exploreExecutions.retry(fileSkillId, input, userMessage, history, emit)
    }

    if (/^\/tts(?:\s|$)/u.test(userMessage.content))
      throw new RetryNotAllowedError('Missing speech execution')

    const lastMessage = history.at(-1)
    if (!lastMessage || lastMessage.id !== userMessage.id) {
      throw new RetryNotAllowedError('only the last unanswered user message can be retried')
    }

    const active = {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId: randomUUID(),
      languages: this.snapshotLanguages()
    }
    this.executions.register(input.requestId, active)
    try {
      const route = await this.agentRuntime.routeConversation({
        mode: 'retry',
        text: userMessage.content,
        ...active.languages,
        signal: active.controller.signal
      })
      active.controller.signal.throwIfAborted()
      if (route.kind !== 'reply' && (route.kind !== 'workflow' || route.workflow !== 'concept'))
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      return this.launchGeneration(
        this.generation(input.requestId, userMessage, active),
        emit,
        route.kind === 'workflow' ? 'concept' : 'conversation'
      )
    } catch (error) {
      this.executions.release(input.requestId, active)
      throw error
    }
  }

  cancelMessage(requestId: string): void {
    this.executions.cancel(requestId)
  }

  private prepareConversation(
    message: StoredMessage,
    speechText?: string
  ): StoredConversation | undefined {
    const draft = this.drafts.get(message.sessionId)
    if (!draft) return undefined
    return {
      ...draft,
      title: (speechText?.replace(/\s+/gu, ' ') ?? message.content)
        .trim()
        .slice(0, CONVERSATION_TITLE_MAX_LENGTH)
        .trim(),
      createdAt: message.createdAt,
      updatedAt: message.createdAt
    }
  }

  // 标题是独立的后台任务；失败保留输入标题，不改变回复的终态。
  private async updateTitle(
    requestId: string,
    message: StoredMessage,
    emit: ConversationEventListener
  ): Promise<void> {
    const active = this.executions.get(requestId)!
    await this.executions.trackTitle(active.controller, async () => {
      try {
        const title = await this.generateTitle(message, active)
        await withConversationPersistence(() =>
          this.repository.updateTitle(message.sessionId, title)
        )
        emit({ type: 'titleUpdated', requestId, sessionId: message.sessionId })
      } catch (error) {
        if (!active.controller.signal.aborted)
          reportConversationFailure(this.diagnostics, 'update-title', requestId, error)
        // 摘要或持久化失败时，已保存的原文标题仍可使用。
      }
    })
  }

  private async generateTitle(message: StoredMessage, active: ActiveExecution): Promise<string> {
    const signal = active.controller.signal
    let title = ''
    try {
      for await (const event of this.agentRuntime.stream({
        messages: [{ role: 'user', content: message.content }],
        sessionId: message.sessionId,
        task: 'conversation-title',
        ...active.languages,
        signal
      })) {
        signal.throwIfAborted()
        // 标题生成是纯正文消费者：提供方即使返回思考增量也忽略。
        if (event.type !== 'text') continue
        title += event.delta
        if (title.length > CONVERSATION_TITLE_MAX_LENGTH * 2)
          throw new ModelRequestError('PROTOCOL', new Error('Title is too long'))
      }
    } catch (error) {
      signal.throwIfAborted()
      if (
        error instanceof AgentRuntimeError ||
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
    return parsed.data
  }

  // 快照只拷贝原始值，不持有 resolver 返回的对象：执行期间设置源变化
  // 不会泄漏进已建立的快照。
  private snapshotLanguages(explicit?: ConversationLanguages): ConversationLanguages {
    const { outputLanguage, targetLanguage } = explicit ?? this.resolveLanguages()
    // Validate trusted explicit context as well; do not weaken language admission.
    if (explicit) {
      targetLanguageSchema.parse(targetLanguage)
      if (!SUPPORTED_LOCALES.includes(outputLanguage))
        throw new Error('Unsupported output language')
    }
    return { outputLanguage, targetLanguage }
  }

  private launchGeneration(
    generation: GenerationStarted,
    emit: ConversationEventListener,
    task: ReplyTask
  ): GenerationAccepted {
    const execution = this.executions.get(generation.requestId)
    if (!execution) {
      throw new Error('Generation execution is not registered')
    }

    void this.runGeneration(generation, execution, emit, task)
    return { accepted: true, generation }
  }

  async shutdown(): Promise<void> {
    this.dispose()
    await this.executions.waitForIdle()
  }

  dispose(): void {
    this.executions.dispose()
    this.drafts.clear()
  }

  private async runGeneration(
    generation: GenerationStarted,
    execution: ActiveExecution,
    emit: ConversationEventListener,
    task: ReplyTask
  ): Promise<void> {
    const { requestId, sessionId, assistantMessageId } = generation
    const eventBase = { requestId, sessionId }
    const publish = this.executions.releaseOnTerminal(execution, emit)

    try {
      // started 的语义：user 消息已持久化、canonical 生成身份已建立。
      publish({ type: 'started', ...generation })

      // 取消发生在 user append 期间：append 完成后仍先发 started 再发 cancelled，
      // 使 UI 与数据库中已存在的 user 消息保持一致。
      if (execution.controller.signal.aborted) {
        publish({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }

      const history = await withConversationPersistence(() => this.repository.history(sessionId))
      const modelMessages: ModelMessage[] = history.map(({ role, content }) => ({ role, content }))
      let response = ''
      const stream = this.agentRuntime.stream({
        sessionId,
        task,
        messages: modelMessages,
        ...execution.languages,
        signal: execution.controller.signal
      })
      for await (const event of stream) {
        if (execution.controller.signal.aborted) break
        if (event.type === 'reasoning') {
          // 思考只作为本次请求的临时展示数据转发：不写入 response，
          // 也不进入最终消息、会话历史与后续模型上下文。
          publish({
            ...eventBase,
            type: 'reasoningChunk',
            messageId: assistantMessageId,
            delta: event.delta
          })
        } else {
          response += event.delta
          publish({
            ...eventBase,
            type: 'chunk',
            messageId: assistantMessageId,
            delta: event.delta
          })
        }
        if (execution.controller.signal.aborted) break
      }

      if (execution.controller.signal.aborted) {
        publish({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }

      const assistantMessage: StoredMessage = {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        content: response,
        createdAt: new Date().toISOString()
      }
      await withConversationPersistence(() => this.repository.appendMessage(assistantMessage))
      publish({ ...eventBase, type: 'completed', message: toConversationMessage(assistantMessage) })
    } catch (error) {
      if (execution.controller.signal.aborted) {
        publish({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
      } else {
        reportConversationFailure(this.diagnostics, 'generate-reply', requestId, error)
        publish({
          ...eventBase,
          type: 'failed',
          messageId: assistantMessageId,
          error: toConversationEventError(error)
        })
      }
    } finally {
      this.executions.release(requestId, execution)
    }
  }
}

function toSummary(conversation: StoredConversation | DraftConversation): ConversationSummary {
  return {
    sessionId: conversation.id,
    title: conversation.title?.slice(0, CONVERSATION_TITLE_MAX_LENGTH).trim() ?? null,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt
  }
}

function byMostRecent(a: ConversationSummary, b: ConversationSummary): number {
  return (
    b.updatedAt.localeCompare(a.updatedAt) ||
    b.createdAt.localeCompare(a.createdAt) ||
    a.sessionId.localeCompare(b.sessionId)
  )
}
