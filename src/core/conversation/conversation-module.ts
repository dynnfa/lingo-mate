import { SpeechError } from '../speech/speech-synthesizer'
import { speechInputSchema } from '../../shared/speech'
import { AgentRuntimeError, type AgentRuntime } from '../agent/agent-runtime'
import { noopCoreDiagnostics, type CoreDiagnostics } from '../error-diagnostics'
import { parseSynonymInput } from '../learning/synonym/parse-synonym-input'
import { randomUUID } from 'node:crypto'
import { classifyModelRequestError, ModelRequestError } from '../llm/llm-client'
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  conversationSummarySchema,
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
import { sentenceTextSchema } from '../../shared/sentence'
import type { ConversationSkill } from './conversation-skill'
import type {
  ConversationSkillRepository,
  StoredConversationSkillExecution
} from './conversation-skill-repository'
import {
  ConversationNotFoundError,
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
  fileResultSkillByCommand,
  type FileResultSkillInput
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
  languages: ConversationLanguages
  userMessageId: string
  assistantMessageId: string
}

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
    if (/^\/tts(?:\s|$)/u.test(input.text)) {
      return this.runSkill(
        {
          requestId: input.requestId,
          sessionId: input.sessionId,
          skillId: 'tts',
          arguments: { text: input.text.replace(/^\/tts(?:\s)?/u, ''), wordLanguage: 'en' }
        },
        emit,
        context
      )
    }
    const conversation =
      this.drafts.get(input.sessionId) ??
      (await withConversationPersistence(() => this.repository.find(input.sessionId)))
    if (!conversation) {
      throw new ConversationNotFoundError(input.sessionId)
    }

    const userMessage: StoredMessage = {
      id: context?.userMessageId ?? randomUUID(),
      sessionId: input.sessionId,
      role: 'user',
      content: input.text,
      createdAt: new Date().toISOString()
    }
    const assistantMessageId = context?.assistantMessageId ?? randomUUID()
    this.executions.register(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId,
      languages: this.snapshotLanguages(context?.languages)
    })

    const titled = this.prepareConversation(userMessage)
    try {
      await withConversationPersistence(() => this.repository.appendMessage(userMessage, titled))
      this.drafts.delete(input.sessionId)
    } catch (error) {
      // user 消息未持久化：不得发 started，也不得让 UI 出现伪消息。
      this.executions.release(input.requestId)
      emit({
        type: 'failed',
        requestId: input.requestId,
        sessionId: input.sessionId,
        error: toConversationEventError(error)
      })
      throw error
    }

    if (titled) void this.updateTitle(input.requestId, userMessage, emit)

    const generation: GenerationStarted = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: toConversationMessage(userMessage),
      assistantMessageId
    }
    return this.launchGeneration(generation, emit)
  }

  async runSkill(
    input: RunConversationSkillInput,
    emit: ConversationEventListener,
    context?: ConversationExecutionContext
  ): Promise<GenerationAccepted> {
    if (input.skillId === 'sentence') sentenceTextSchema.parse(input.arguments.text)
    if (input.skillId === 'synonym') parseSynonymInput(input.arguments.text)
    if (input.skillId === 'tts') {
      const parsed = speechInputSchema.safeParse({
        requestId: input.requestId,
        text: input.arguments.text,
        language: 'en'
      })
      if (!parsed.success) throw new SpeechError('INVALID_INPUT')
    }
    runConversationSkillInputSchema.parse(input)
    const skill = this.skills.get(input.skillId)
    if (!skill) {
      throw new Error('Conversation skills are not configured')
    }
    const conversation =
      this.drafts.get(input.sessionId) ??
      (await withConversationPersistence(() => this.repository.find(input.sessionId)))
    if (!conversation) throw new ConversationNotFoundError(input.sessionId)

    // 技能执行的 wordLanguage 来源于目标语言快照；客户端传值与当前设置
    // 不一致时明确拒绝，不接受旧值静默执行。
    const languages = this.snapshotLanguages(context?.languages)
    if (input.arguments.wordLanguage !== languages.targetLanguage) {
      throw new SkillLanguageMismatchError(input.arguments.wordLanguage, languages.targetLanguage)
    }
    // 探索技能（explore-phrase / explore-vocabulary）的结果走各自的 JSON 历史
    // 文件路径：不创建数据库技能执行，也不写数据库报告；命令消息与最终助手
    // 消息仍走会话消息接口。
    if (input.skillId === 'explore-phrase' || input.skillId === 'explore-vocabulary') {
      return this.runExploreFileSkill(input, skill, languages, emit)
    }
    if (!this.storedSkills) {
      throw new Error('Conversation skills are not configured')
    }
    const now = new Date().toISOString()
    const userMessage: StoredMessage = {
      id: context?.userMessageId ?? randomUUID(),
      sessionId: input.sessionId,
      role: 'user',
      content: `/${input.skillId} ${input.arguments.text}`,
      createdAt: now
    }
    const assistantMessageId = context?.assistantMessageId ?? randomUUID()
    this.executions.register(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId,
      languages
    })

    const titled = this.prepareConversation(userMessage)
    let execution: StoredConversationSkillExecution
    try {
      execution = await this.storedSkills.create(input, userMessage, languages, titled)
      this.drafts.delete(input.sessionId)
    } catch (error) {
      this.executions.release(input.requestId)
      emit({
        type: 'failed',
        requestId: input.requestId,
        sessionId: input.sessionId,
        error: toConversationEventError(error)
      })
      throw error
    }

    if (titled && input.skillId !== 'tts') void this.updateTitle(input.requestId, userMessage, emit)

    const generation: GenerationStarted = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: toConversationMessage(userMessage),
      assistantMessageId
    }
    const active = this.executions.get(input.requestId)
    if (!active) throw new Error('Skill execution is not registered')
    void this.storedSkills.run(generation, execution, skill, active, emit)
    return { accepted: true, generation }
  }

  // 探索技能执行：无数据库执行记录，executionId 在 JSON 批次提交时
  // 与 userMessageId 建立稳定关联；失败重试按该身份从文件恢复。
  private async runExploreFileSkill(
    input: FileResultSkillInput,
    skill: ConversationSkill,
    languages: ConversationLanguages,
    emit: ConversationEventListener
  ): Promise<GenerationAccepted> {
    const now = new Date().toISOString()
    const userMessage: StoredMessage = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: 'user',
      // 无参数命令：用户消息就是命令本身，不拼接空文本。
      content: `/${input.skillId}`,
      createdAt: now
    }
    const executionId = randomUUID()
    const assistantMessageId = exploreReplyId(input.skillId, userMessage.id)
    this.executions.register(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId,
      languages
    })

    const titled = this.prepareConversation(userMessage)
    try {
      await withConversationPersistence(() => this.repository.appendMessage(userMessage, titled))
      this.drafts.delete(input.sessionId)
    } catch (error) {
      this.executions.release(input.requestId)
      emit({
        type: 'failed',
        requestId: input.requestId,
        sessionId: input.sessionId,
        error: toConversationEventError(error)
      })
      throw error
    }

    if (titled) void this.updateTitle(input.requestId, userMessage, emit)

    const generation: GenerationStarted = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: toConversationMessage(userMessage),
      assistantMessageId
    }
    const active = this.executions.get(input.requestId)
    if (!active) throw new Error('Skill execution is not registered')
    void this.exploreExecutions.run(generation, executionId, input, skill, active, emit)
    return { accepted: true, generation }
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

    const assistantMessageId = randomUUID()
    // 普通回复重试视为新执行，读取当前语言设置。
    this.executions.register(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId,
      languages: this.snapshotLanguages()
    })

    const generation: GenerationStarted = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: toConversationMessage(userMessage),
      assistantMessageId
    }
    return this.launchGeneration(generation, emit)
  }

  cancelMessage(requestId: string): void {
    this.executions.cancel(requestId)
  }

  private prepareConversation(message: StoredMessage): StoredConversation | undefined {
    const draft = this.drafts.get(message.sessionId)
    if (!draft) return undefined
    const command = /^\/tts\s/u.exec(message.content)
    return {
      ...draft,
      title: (command
        ? message.content.slice(command[0].length).replace(/\s+/gu, ' ')
        : message.content
      )
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
    emit: ConversationEventListener
  ): GenerationAccepted {
    const execution = this.executions.get(generation.requestId)
    if (!execution) {
      throw new Error('Generation execution is not registered')
    }

    void this.runGeneration(generation, execution, emit)
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

      const history = await withConversationPersistence(() => this.repository.history(sessionId))
      const modelMessages: ModelMessage[] = history.map(({ role, content }) => ({ role, content }))
      let response = ''
      const stream = this.agentRuntime.stream({
        sessionId,
        task: 'conversation',
        messages: modelMessages,
        ...execution.languages,
        signal: execution.controller.signal
      })
      for await (const event of stream) {
        if (execution.controller.signal.aborted) break
        if (event.type === 'reasoning') {
          // 思考只作为本次请求的临时展示数据转发：不写入 response，
          // 也不进入最终消息、会话历史与后续模型上下文。
          emit({
            ...eventBase,
            type: 'reasoningChunk',
            messageId: assistantMessageId,
            delta: event.delta
          })
        } else {
          response += event.delta
          emit({ ...eventBase, type: 'chunk', messageId: assistantMessageId, delta: event.delta })
        }
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
      await withConversationPersistence(() => this.repository.appendMessage(assistantMessage))
      emit({ ...eventBase, type: 'completed', message: toConversationMessage(assistantMessage) })
    } catch (error) {
      if (execution.controller.signal.aborted) {
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
      } else {
        reportConversationFailure(this.diagnostics, 'generate-reply', requestId, error)
        emit({
          ...eventBase,
          type: 'failed',
          messageId: assistantMessageId,
          error: toConversationEventError(error)
        })
      }
    } finally {
      this.executions.release(requestId)
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
