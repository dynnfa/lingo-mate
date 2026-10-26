import { SpeechError } from '../speech/speech-synthesizer'
import { speechInputSchema, isTtsReport } from '../../shared/speech'
import { AgentRuntimeError, type AgentRuntime } from '../agent/agent-runtime'
import { noopCoreDiagnostics, type CoreDiagnostics } from '../error-diagnostics'
import { SynonymError, parseSynonymInput } from '../learning/synonym/parse-synonym-input'
import { createHash, randomUUID } from 'node:crypto'
import { classifyModelRequestError, ModelRequestError } from '../llm/llm-client'
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  conversationSummarySchema,
  type ConversationSkillId
} from '../../shared/conversation'
import type {
  ConversationEvent,
  ConversationMessage,
  ConversationSkillReport,
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
import type { ModelMessage } from '../llm/language-model'
import { ModelConfigValidationError, ModelNotConfiguredError } from '../llm/model-config'
import { VocabularyError } from '../learning/vocabulary/parse-vocabulary-input'
import { PhraseError } from '../learning/phrase/parse-phrase-input'
import { ExplorePhraseError } from '../learning/explore-phrase/explore-phrase-error'
import { ExploreVocabularyError } from '../learning/explore-vocabulary/explore-vocabulary-error'
import { isExplorePhraseReport, type ExplorePhraseReport } from '../../shared/explore-phrase'
import {
  isExploreVocabularyReport,
  type ExploreVocabularyReport
} from '../../shared/explore-vocabulary'
import type { ConversationSkill, ConversationSkillRunInput } from './conversation-skill'
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

// 文件结果技能：结果不走数据库技能执行，而是各自的 JSON 历史文件。命令
// 消息内容与稳定回复 ID 命名空间按技能区分；新增文件结果技能时在此登记。
const FILE_RESULT_SKILLS = {
  'explore-phrase': { command: '/explore-phrase' },
  'explore-vocabulary': { command: '/explore-vocabulary' }
} as const

type FileResultSkillId = keyof typeof FILE_RESULT_SKILLS

type FileResultSkillInput = Extract<RunConversationSkillInput, { skillId: FileResultSkillId }>

type FileResultExploreReport = ExplorePhraseReport | ExploreVocabularyReport

// 会话中保存的命令形态就是命令本身（无参数），按内容精确匹配。
function fileResultSkillByCommand(content: string): FileResultSkillId | undefined {
  if (content === FILE_RESULT_SKILLS['explore-phrase'].command) return 'explore-phrase'
  if (content === FILE_RESULT_SKILLS['explore-vocabulary'].command) return 'explore-vocabulary'
  return undefined
}

// 恢复的报告必须属于该命令对应的技能：词汇批次不得当作短语报告使用。
// 命中时报告必为对应技能的报告，因此收窄到联合类型是可靠的。
function isFileResultReport(
  skillId: FileResultSkillId,
  report: unknown
): report is FileResultExploreReport {
  return skillId === 'explore-phrase'
    ? isExplorePhraseReport(report)
    : isExploreVocabularyReport(report)
}

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
  private closed = false
  private readonly idleListeners = new Set<() => void>()
  private readonly titleControllers = new Set<AbortController>()
  private readonly drafts = new Map<string, DraftConversation>()
  private readonly activeRequests = new Map<string, ActiveExecution>()
  private readonly sessionRequests = new Map<string, string>()
  // Runtime-only: absent entries never authorize regenerating a missing old batch.
  // 运行期记录携带技能身份：词汇请求不得被重试为短语请求。
  private readonly uncommittedExploreExecutions = new Map<
    string,
    {
      skillId: FileResultSkillId
      executionId: string
      languages: ConversationLanguages
    }
  >()

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
    private readonly skillRepository?: ConversationSkillRepository,
    private readonly diagnostics: CoreDiagnostics = noopCoreDiagnostics
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
    const visibleMessages = await Promise.all(
      messages.map(async (message) => {
        const fileSkillId =
          message.role === 'user' ? fileResultSkillByCommand(message.content) : undefined
        if (!fileSkillId || findExploreReply(fileSkillId, message, messages))
          return toMessage(message)
        const pending = this.uncommittedExploreExecutions.get(message.id)
        if (pending?.skillId === fileSkillId) return toMessage({ ...message, retryable: true })
        try {
          const report = await this.skills.get(fileSkillId)?.restoreReport?.(message.id)
          return toMessage({ ...message, retryable: isFileResultReport(fileSkillId, report) })
        } catch (error) {
          // A broken history file must not hide already saved conversation messages.
          this.reportFailure(`load-${fileSkillId}`, message.id, error)
          return toMessage(message)
        }
      })
    )
    return { conversation: toSummary(conversation), messages: visibleMessages }
  }

  async sendMessage(
    input: SendMessageInput,
    emit: ConversationEventListener
  ): Promise<GenerationAccepted> {
    if (/^\/tts(?:\s|$)/u.test(input.text)) {
      return this.runSkill(
        {
          requestId: input.requestId,
          sessionId: input.sessionId,
          skillId: 'tts',
          arguments: { text: input.text.replace(/^\/tts(?:\s)?/u, ''), wordLanguage: 'en' }
        },
        emit
      )
    }
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

    const titled = this.prepareConversation(userMessage)
    try {
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

    if (titled) void this.updateTitle(input.requestId, userMessage, emit)

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
      (await this.withPersistence(() => this.repository.find(input.sessionId)))
    if (!conversation) throw new ConversationNotFoundError(input.sessionId)

    // 技能执行的 wordLanguage 来源于目标语言快照；客户端传值与当前设置
    // 不一致时明确拒绝，不接受旧值静默执行。
    const languages = this.snapshotLanguages()
    if (input.arguments.wordLanguage !== languages.targetLanguage) {
      throw new SkillLanguageMismatchError(input.arguments.wordLanguage, languages.targetLanguage)
    }
    // 探索技能（explore-phrase / explore-vocabulary）的结果走各自的 JSON 历史
    // 文件路径：不创建数据库技能执行，也不写数据库报告；命令消息与最终助手
    // 消息仍走会话消息接口。
    if (input.skillId === 'explore-phrase' || input.skillId === 'explore-vocabulary') {
      return this.runExploreFileSkill(input, skill, languages, emit)
    }
    if (!this.skillRepository) {
      throw new Error('Conversation skills are not configured')
    }
    const now = new Date().toISOString()
    const userMessage: StoredMessage = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: 'user',
      content: `/${input.skillId} ${input.arguments.text}`,
      createdAt: now
    }
    // 两个技能分支共享同一基础形状；skillId 字面量决定报告判别类型。
    const executionBase = {
      id: randomUUID(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      arguments: input.arguments,
      explanationLanguage: languages.outputLanguage,
      phase: 'started' as const,
      createdAt: now,
      updatedAt: now
    }
    const execution: StoredConversationSkillExecution =
      input.skillId === 'tts'
        ? { ...executionBase, skillId: 'tts' }
        : input.skillId === 'synonym'
          ? { ...executionBase, skillId: 'synonym' }
          : input.skillId === 'phrase'
            ? { ...executionBase, skillId: 'phrase' }
            : { ...executionBase, skillId: 'vocabulary' }
    const assistantMessageId = randomUUID()
    this.registerExecution(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId,
      languages
    })

    const titled = this.prepareConversation(userMessage)
    try {
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

    if (titled && input.skillId !== 'tts') void this.updateTitle(input.requestId, userMessage, emit)

    const generation: GenerationStarted = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: toMessage(userMessage),
      assistantMessageId
    }
    const active = this.activeRequests.get(input.requestId)
    if (!active) throw new Error('Skill execution is not registered')
    void this.runSkillExecution(generation, execution, skill, active, emit)
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
      content: FILE_RESULT_SKILLS[input.skillId].command,
      createdAt: now
    }
    const executionId = randomUUID()
    const assistantMessageId = exploreReplyId(input.skillId, userMessage.id)
    this.registerExecution(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId,
      languages
    })

    const titled = this.prepareConversation(userMessage)
    try {
      await this.withPersistence(() => this.repository.appendMessage(userMessage, titled))
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

    if (titled) void this.updateTitle(input.requestId, userMessage, emit)

    const generation: GenerationStarted = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: toMessage(userMessage),
      assistantMessageId
    }
    const active = this.activeRequests.get(input.requestId)
    if (!active) throw new Error('Skill execution is not registered')
    void this.runExploreExecution(generation, executionId, input, skill, active, emit)
    return { accepted: true, generation }
  }

  private async runExploreExecution(
    generation: GenerationStarted,
    executionId: string,
    input: FileResultSkillInput,
    skill: ConversationSkill,
    execution: ActiveExecution,
    emit: ConversationEventListener
  ): Promise<void> {
    const { requestId, sessionId, assistantMessageId } = generation
    const eventBase = { requestId, sessionId }
    const retryIdentity = { skillId: input.skillId, executionId, languages: execution.languages }
    this.uncommittedExploreExecutions.set(execution.userMessageId, retryIdentity)
    try {
      emit({ type: 'started', ...generation })
      if (execution.controller.signal.aborted) {
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }
      const result = await skill.run({
        requestId,
        executionId,
        sessionId,
        userMessageId: execution.userMessageId,
        arguments: input.arguments,
        explanationLanguage: execution.languages.outputLanguage,
        signal: execution.controller.signal,
        onPhase: async (phase) => {
          if (phase === 'committing')
            this.uncommittedExploreExecutions.delete(execution.userMessageId)
          emit({ ...eventBase, type: 'skillPhase', phase })
        },
        isReportProtected: (report) => this.isExploreReportProtected(report)
      } satisfies ConversationSkillRunInput)
      if (result.outcome === 'cancelled') {
        this.uncommittedExploreExecutions.set(execution.userMessageId, retryIdentity)
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }
      this.uncommittedExploreExecutions.delete(execution.userMessageId)
      await this.persistExploreReply(generation, result.report, skill, emit)
    } catch (error) {
      // These failures guarantee that atomic replacement did not happen.
      // COMMIT_UNCERTAIN deliberately does not authorize regeneration.
      if (
        (error instanceof ExplorePhraseError || error instanceof ExploreVocabularyError) &&
        ['STORAGE_FAILED', 'HISTORY_UNREADABLE', 'HISTORY_MODIFIED', 'RECOVERY_PENDING'].includes(
          error.code
        )
      ) {
        this.uncommittedExploreExecutions.set(execution.userMessageId, retryIdentity)
      }
      if (
        execution.controller.signal.aborted &&
        this.uncommittedExploreExecutions.has(execution.userMessageId)
      ) {
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
      } else {
        this.reportFailure(`run-${input.skillId}`, requestId, error)
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

  // 探索回复是本地格式化的 Markdown 表格；批次提交成功而消息保存失败时，
  // 重试按 userMessageId 从 JSON 批次恢复同一结果，不重新生成。
  private async persistExploreReply(
    generation: GenerationStarted,
    report: ConversationSkillReport,
    skill: ConversationSkill,
    emit: ConversationEventListener
  ): Promise<void> {
    const exploreReport: FileResultExploreReport | undefined = isExplorePhraseReport(report)
      ? report
      : isExploreVocabularyReport(report)
        ? report
        : undefined
    if (!exploreReport) {
      throw new Error('Unexpected explore report')
    }
    // 反馈语言使用批次携带的解释语言快照，恢复路径与此保持一致。
    const feedback = skill.feedback(exploreReport, exploreReport.explanationLanguage)
    const assistantMessage: StoredMessage = {
      id: generation.assistantMessageId,
      sessionId: generation.sessionId,
      role: 'assistant',
      content: feedback,
      createdAt: new Date().toISOString()
    }
    await this.withPersistence(() => this.repository.appendMessage(assistantMessage))
    emit({
      requestId: generation.requestId,
      sessionId: generation.sessionId,
      type: 'completed',
      message: toMessage(assistantMessage),
      skillCompletion: 'complete'
    })
  }

  // JSON 历史批次的淘汰保护：批次对应的 user 消息尚无该技能的 assistant
  // 回复（或读取失败）时视为仍在恢复窗口内，不得被新批次淘汰。
  private async isExploreReportProtected(report: ConversationSkillReport): Promise<boolean> {
    const exploreReport: FileResultExploreReport | undefined = isExplorePhraseReport(report)
      ? report
      : isExploreVocabularyReport(report)
        ? report
        : undefined
    if (!exploreReport) return false
    const skillId: FileResultSkillId = isExplorePhraseReport(exploreReport)
      ? 'explore-phrase'
      : 'explore-vocabulary'
    try {
      const history = await this.withPersistence(() =>
        this.repository.history(exploreReport.sessionId)
      )
      const index = history.findIndex(
        (message) => message.id === exploreReport.userMessageId && message.role === 'user'
      )
      if (index === -1) return false
      return !findExploreReply(skillId, history[index], history)
    } catch {
      // 无法核实时保守保护，避免淘汰可能仍在恢复的批次。
      return true
    }
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
      const skill = this.skills.get(skillExecution.skillId)
      if (!skill || skillExecution.phase === 'completed') {
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
      if (
        skillExecution.batch &&
        (skillExecution.skillId !== 'synonym' || skillExecution.batch.finalized === true)
      ) {
        void this.retrySkillReply(
          generation,
          skillExecution,
          skillExecution.batch,
          skill,
          active,
          emit
        )
      } else {
        void this.runSkillExecution(generation, skillExecution, skill, active, emit)
      }
      return { accepted: true, generation }
    }

    // File-backed exploration recovery uses saved replies/batches first. Only a
    // known uncommitted execution from this process may run the model again.
    const fileSkillId = fileResultSkillByCommand(userMessage.content)
    if (fileSkillId) {
      return this.retryExploreMessage(fileSkillId, input, userMessage, history, emit)
    }

    if (/^\/tts(?:\s|$)/u.test(userMessage.content))
      throw new RetryNotAllowedError('Missing speech execution')

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

  // Window-retained batches may recover even after later messages. Missing results
  // may regenerate only when this process knows the execution never committed.
  // 运行期记录携带技能身份：待提交执行只授权同一技能的重试。
  private async retryExploreMessage(
    skillId: FileResultSkillId,
    input: RetryMessageInput,
    userMessage: StoredMessage,
    history: StoredMessage[],
    emit: ConversationEventListener
  ): Promise<GenerationAccepted> {
    const skill = this.skills.get(skillId)
    if (!skill?.restoreReport) {
      throw new RetryNotAllowedError(`${skillId} execution cannot be retried`)
    }
    if (findExploreReply(skillId, userMessage, history)) {
      throw new RetryNotAllowedError(`${skillId} already has a reply`)
    }
    const report = await skill.restoreReport(userMessage.id)
    const pending = this.uncommittedExploreExecutions.get(userMessage.id)
    if (report && !isFileResultReport(skillId, report)) {
      throw new RetryNotAllowedError(`unexpected ${skillId} report`)
    }
    if (!report && (!pending || pending.skillId !== skillId)) {
      throw new RetryNotAllowedError(`${skillId} result is not recoverable`)
    }
    const assistantMessageId = exploreReplyId(skillId, userMessage.id)
    const languages = report
      ? {
          outputLanguage: report.explanationLanguage,
          targetLanguage: report.wordLanguage
        }
      : pending!.languages
    this.registerExecution(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId,
      languages
    })
    const generation: GenerationStarted = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: toMessage({ ...userMessage, retryable: false }),
      assistantMessageId
    }
    const active = this.activeRequests.get(input.requestId)
    if (!active) throw new Error('Explore retry is not registered')
    if (report) {
      void this.retryExploreReply(generation, report, skill, active, emit)
    } else {
      void this.runExploreExecution(
        generation,
        pending!.executionId,
        {
          requestId: input.requestId,
          sessionId: input.sessionId,
          skillId,
          arguments: { wordLanguage: 'en' }
        },
        skill,
        active,
        emit
      )
    }
    return { accepted: true, generation }
  }

  private async retryExploreReply(
    generation: GenerationStarted,
    report: FileResultExploreReport,
    skill: ConversationSkill,
    execution: ActiveExecution,
    emit: ConversationEventListener
  ): Promise<void> {
    const { requestId, sessionId, assistantMessageId } = generation
    const eventBase = { requestId, sessionId }
    try {
      emit({ type: 'started', ...generation })
      if (execution.controller.signal.aborted) {
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }
      emit({ ...eventBase, type: 'skillPhase', phase: 'summarizing' })
      await this.persistExploreReply(generation, report, skill, emit)
    } catch (error) {
      const skillId: FileResultSkillId = isExplorePhraseReport(report)
        ? 'explore-phrase'
        : 'explore-vocabulary'
      this.reportFailure(`retry-${skillId}`, requestId, error)
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

  cancelMessage(requestId: string): void {
    const execution = this.activeRequests.get(requestId)
    if (!execution) {
      throw new RequestNotFoundError(requestId)
    }
    execution.controller.abort()
  }

  private prepareConversation(message: StoredMessage): StoredConversation | undefined {
    const draft = this.drafts.get(message.sessionId)
    if (!draft) return undefined
    return {
      ...draft,
      title: (message.content.startsWith('/tts ')
        ? message.content.slice(5).replace(/\s+/gu, ' ')
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
    const active = this.activeRequests.get(requestId)!
    this.titleControllers.add(active.controller)
    try {
      const title = await this.generateTitle(message, active)
      await this.withPersistence(() => this.repository.updateTitle(message.sessionId, title))
      emit({ type: 'titleUpdated', requestId, sessionId: message.sessionId })
    } catch (error) {
      if (!active.controller.signal.aborted) this.reportFailure('update-title', requestId, error)
      // 摘要或持久化失败时，已保存的原文标题仍可使用。
    } finally {
      this.titleControllers.delete(active.controller)
      this.notifyIdle()
    }
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
  private snapshotLanguages(): ConversationLanguages {
    const { outputLanguage, targetLanguage } = this.resolveLanguages()
    return { outputLanguage, targetLanguage }
  }

  private registerExecution(requestId: string, execution: ActiveExecution): void {
    if (this.closed) throw new AgentRuntimeError('AGENT_UNAVAILABLE')
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

  async shutdown(): Promise<void> {
    this.dispose()
    if (!this.activeRequests.size && !this.titleControllers.size) return
    await new Promise<void>((resolve) => this.idleListeners.add(resolve))
  }

  private notifyIdle(): void {
    if (this.activeRequests.size || this.titleControllers.size) return
    for (const resolve of this.idleListeners) resolve()
    this.idleListeners.clear()
  }

  dispose(): void {
    this.closed = true
    for (const controller of this.titleControllers) controller.abort()
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
      await this.withPersistence(() => this.repository.appendMessage(assistantMessage))
      emit({ ...eventBase, type: 'completed', message: toMessage(assistantMessage) })
    } catch (error) {
      if (execution.controller.signal.aborted) {
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
      } else {
        this.reportFailure('generate-reply', requestId, error)
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

  private async runSkillExecution(
    generation: GenerationStarted,
    skillExecution: StoredConversationSkillExecution,
    skill: ConversationSkill,
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

      const result = await skill.run({
        requestId,
        executionId: skillExecution.id,
        sessionId,
        userMessageId: execution.userMessageId,
        arguments: skillExecution.arguments,
        explanationLanguage: skillExecution.explanationLanguage,
        previousReport: skillExecution.batch,
        signal: execution.controller.signal,
        onPhase: async (phase) => {
          await this.skillRepository!.setExecutionPhase(skillExecution.id, phase)
          emit({ ...eventBase, type: 'skillPhase', phase })
        }
      } satisfies ConversationSkillRunInput)

      if (result.outcome === 'cancelled') {
        await this.skillRepository!.setExecutionPhase(skillExecution.id, 'cancelled')
        emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }
      await this.persistSkillReply(generation, skillExecution, result.report, skill, emit)
    } catch (error) {
      if (execution.controller.signal.aborted) {
        try {
          await this.skillRepository!.setExecutionPhase(skillExecution.id, 'cancelled')
          emit({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        } catch (persistenceError) {
          this.reportFailure('set-cancelled-phase', requestId, persistenceError)
          emit({
            ...eventBase,
            type: 'failed',
            messageId: assistantMessageId,
            error: this.toSafeError(persistenceError)
          })
        }
      } else {
        this.reportFailure('run-skill', requestId, error)
        try {
          await this.skillRepository!.setExecutionPhase(skillExecution.id, 'failed')
        } catch (persistenceError) {
          this.reportFailure('set-failed-phase', requestId, persistenceError)
          // 对外仍返回原始业务错误；二次持久化失败仅进入内部日志。
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

  // 恢复流程只依据已持久化报告生成本地反馈：不再次调用模型，也不再次写业务表。
  private async retrySkillReply(
    generation: GenerationStarted,
    skillExecution: StoredConversationSkillExecution,
    report: ConversationSkillReport,
    skill: ConversationSkill,
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
      await this.persistSkillReply(generation, skillExecution, report, skill, emit)
    } catch (error) {
      this.reportFailure('retry-skill-reply', requestId, error)
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
    report: ConversationSkillReport,
    skill: ConversationSkill,
    emit: ConversationEventListener
  ): Promise<void> {
    const feedback = skill.feedback(report, skillExecution.explanationLanguage)
    const assistantMessage: StoredMessage = {
      id: generation.assistantMessageId,
      sessionId: generation.sessionId,
      role: 'assistant',
      content: feedback,
      ...(isTtsReport(report) ? { speech: report.speech } : {}),
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

  private reportFailure(operation: string, requestId: string, error: unknown): void {
    try {
      this.diagnostics.report({
        module: 'conversation',
        operation,
        requestId,
        message: `conversation ${operation} failed`,
        error
      })
    } catch {
      // 诊断故障不能阻断失败终态或请求清理。
    }
  }

  private releaseExecution(requestId: string): void {
    const execution = this.activeRequests.get(requestId)
    this.activeRequests.delete(requestId)
    if (execution && this.sessionRequests.get(execution.sessionId) === requestId) {
      this.sessionRequests.delete(execution.sessionId)
    }
    this.notifyIdle()
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
    if (error instanceof SpeechError) return { code: 'SPEECH_ERROR', speechCode: error.code }
    if (error instanceof AgentRuntimeError) return { code: error.code }
    if (error instanceof SynonymError) {
      if (error.code === 'STORAGE_FAILED') return { code: 'PERSISTENCE_ERROR' }
      if (
        error.code === 'TOOL_CALL_NOT_SUPPORTED' ||
        error.code === 'MODEL_NOT_CONFIGURED' ||
        error.code === 'CREDENTIAL_DECRYPT_FAILED'
      )
        return { code: error.code }
      return { code: 'MODEL_ERROR' }
    }
    if (error instanceof ConversationPersistenceError) {
      return { code: 'PERSISTENCE_ERROR' }
    }

    if (error instanceof VocabularyError && error.code === 'STORAGE_FAILED') {
      return { code: 'PERSISTENCE_ERROR' }
    }

    if (error instanceof VocabularyError && error.code === 'TOOL_CALL_NOT_SUPPORTED') {
      return { code: 'TOOL_CALL_NOT_SUPPORTED' }
    }

    if (error instanceof PhraseError && error.code === 'STORAGE_FAILED') {
      return { code: 'PERSISTENCE_ERROR' }
    }

    if (error instanceof PhraseError && error.code === 'TOOL_CALL_NOT_SUPPORTED') {
      return { code: 'TOOL_CALL_NOT_SUPPORTED' }
    }

    if (error instanceof ExplorePhraseError) {
      if (
        error.code === 'STORAGE_FAILED' ||
        error.code === 'COMMIT_UNCERTAIN' ||
        error.code === 'HISTORY_UNREADABLE' ||
        error.code === 'HISTORY_MODIFIED' ||
        error.code === 'RECOVERY_PENDING'
      ) {
        return { code: 'PERSISTENCE_ERROR' }
      }
      if (error.code === 'TOOL_CALL_NOT_SUPPORTED') return { code: 'TOOL_CALL_NOT_SUPPORTED' }
      if (error.code === 'MODEL_NOT_CONFIGURED') return { code: 'MODEL_NOT_CONFIGURED' }
      if (error.code === 'CREDENTIAL_DECRYPT_FAILED') return { code: 'CREDENTIAL_DECRYPT_FAILED' }
      return { code: 'MODEL_ERROR' }
    }

    if (error instanceof ExploreVocabularyError) {
      if (
        error.code === 'STORAGE_FAILED' ||
        error.code === 'COMMIT_UNCERTAIN' ||
        error.code === 'HISTORY_UNREADABLE' ||
        error.code === 'HISTORY_MODIFIED' ||
        error.code === 'RECOVERY_PENDING'
      ) {
        return { code: 'PERSISTENCE_ERROR' }
      }
      if (error.code === 'TOOL_CALL_NOT_SUPPORTED') return { code: 'TOOL_CALL_NOT_SUPPORTED' }
      if (error.code === 'MODEL_NOT_CONFIGURED') return { code: 'MODEL_NOT_CONFIGURED' }
      if (error.code === 'CREDENTIAL_DECRYPT_FAILED') return { code: 'CREDENTIAL_DECRYPT_FAILED' }
      return { code: 'MODEL_ERROR' }
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
    title: conversation.title?.slice(0, CONVERSATION_TITLE_MAX_LENGTH).trim() ?? null,
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
    ...(message.speech ? { speech: message.speech } : {}),
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

// UUIDv8 derived from the user identity: reply association survives restarts and
// history-window eviction without adding a database column or changing JSON.
// 命名空间按技能区分：词汇回复 ID 与短语回复 ID 不同，避免跨技能碰撞。
function exploreReplyId(skillId: FileResultSkillId, userMessageId: string): string {
  const bytes = createHash('sha256')
    .update(`${skillId}-reply:${userMessageId}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function findExploreReply(
  skillId: FileResultSkillId,
  user: StoredMessage,
  history: StoredMessage[]
): StoredMessage | undefined {
  const replyId = exploreReplyId(skillId, user.id)
  const reply = history.find((message) => message.role === 'assistant' && message.id === replyId)
  if (reply) return reply
  // Legacy replies used random IDs and were always appended directly after the
  // command. Do not mistake another command's newly recovered reply for this one.
  const adjacent = history[history.findIndex((message) => message.id === user.id) + 1]
  if (adjacent?.role !== 'assistant') return undefined
  const command = FILE_RESULT_SKILLS[skillId].command
  const belongsToAnotherCommand = history.some(
    (message) =>
      message.role === 'user' &&
      message.content === command &&
      exploreReplyId(skillId, message.id) === adjacent.id
  )
  return belongsToAnotherCommand ? undefined : adjacent
}
