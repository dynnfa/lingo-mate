import { createHash } from 'node:crypto'
import type {
  ConversationMessage,
  ConversationSkillId,
  ConversationSkillReport,
  GenerationAccepted,
  GenerationStarted,
  RetryMessageInput,
  RunConversationSkillInput
} from '../../shared/conversation'
import { isExplorePhraseReport, type ExplorePhraseReport } from '../../shared/explore-phrase'
import {
  isExploreVocabularyReport,
  type ExploreVocabularyReport
} from '../../shared/explore-vocabulary'
import { noopCoreDiagnostics, type CoreDiagnostics } from '../error-diagnostics'
import { ExplorePhraseError } from '../learning/explore-phrase/explore-phrase-error'
import { ExploreVocabularyError } from '../learning/explore-vocabulary/explore-vocabulary-error'
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
  RetryNotAllowedError,
  type ConversationRepository,
  type StoredMessage
} from './conversation-repository'
import type { ConversationSkill, ConversationSkillRunInput } from './conversation-skill'

// 文件结果技能：结果不走数据库技能执行，而是各自的 JSON 历史文件。命令
// 消息内容与稳定回复 ID 命名空间按技能区分；新增文件结果技能时在此登记。
const FILE_RESULT_SKILLS = {
  'explore-phrase': { command: '/explore-phrase' },
  'explore-vocabulary': { command: '/explore-vocabulary' }
} as const

type FileResultSkillId = keyof typeof FILE_RESULT_SKILLS

export type FileResultSkillInput = Extract<
  RunConversationSkillInput,
  { skillId: FileResultSkillId }
>

type FileResultExploreReport = ExplorePhraseReport | ExploreVocabularyReport

// 会话中保存的命令形态就是命令本身（无参数），按内容精确匹配。
export function fileResultSkillByCommand(content: string): FileResultSkillId | undefined {
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

// JSON 批次的恢复身份、重试授权和窗口保护集中在这里，不与 SQLite 执行混用。
export class ExploreConversationExecution {
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
    private readonly skills: ReadonlyMap<ConversationSkillId, ConversationSkill>,
    private readonly executions: ConversationExecutions,
    private readonly diagnostics: CoreDiagnostics = noopCoreDiagnostics
  ) {}

  async loadMessages(messages: StoredMessage[]): Promise<ConversationMessage[]> {
    return Promise.all(
      messages.map(async (message) => {
        const fileSkillId =
          message.role === 'user' ? fileResultSkillByCommand(message.content) : undefined
        if (!fileSkillId || findExploreReply(fileSkillId, message, messages))
          return toConversationMessage(message)
        const pending = this.uncommittedExploreExecutions.get(message.id)
        if (pending?.skillId === fileSkillId)
          return toConversationMessage({ ...message, retryable: true })
        try {
          const report = await this.skills.get(fileSkillId)?.restoreReport?.(message.id)
          return toConversationMessage({
            ...message,
            retryable: isFileResultReport(fileSkillId, report)
          })
        } catch (error) {
          // A broken history file must not hide already saved conversation messages.
          reportConversationFailure(this.diagnostics, `load-${fileSkillId}`, message.id, error)
          return toConversationMessage(message)
        }
      })
    )
  }

  async run(
    generation: GenerationStarted,
    executionId: string,
    input: FileResultSkillInput,
    skill: ConversationSkill,
    execution: ActiveExecution,
    emit: ConversationEventListener
  ): Promise<void> {
    const { requestId, sessionId, assistantMessageId } = generation
    const eventBase = { requestId, sessionId }
    const publish = this.executions.releaseOnTerminal(execution, emit)
    const retryIdentity = { skillId: input.skillId, executionId, languages: execution.languages }
    this.uncommittedExploreExecutions.set(execution.userMessageId, retryIdentity)
    try {
      publish({ type: 'started', ...generation })
      if (execution.controller.signal.aborted) {
        publish({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
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
          publish({ ...eventBase, type: 'skillPhase', phase })
        },
        isReportProtected: (report) => this.isExploreReportProtected(report)
      } satisfies ConversationSkillRunInput)
      if (result.outcome === 'cancelled') {
        this.uncommittedExploreExecutions.set(execution.userMessageId, retryIdentity)
        publish({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }
      this.uncommittedExploreExecutions.delete(execution.userMessageId)
      await this.persistExploreReply(generation, result.report, skill, publish)
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
        publish({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
      } else {
        reportConversationFailure(this.diagnostics, `run-${input.skillId}`, requestId, error)
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
    await withConversationPersistence(() => this.repository.appendMessage(assistantMessage))
    emit({
      requestId: generation.requestId,
      sessionId: generation.sessionId,
      type: 'completed',
      message: toConversationMessage(assistantMessage),
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
      const history = await withConversationPersistence(() =>
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

  // Window-retained batches may recover even after later messages. Missing results
  // may regenerate only when this process knows the execution never committed.
  // 运行期记录携带技能身份：待提交执行只授权同一技能的重试。
  async retry(
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
    this.executions.register(input.requestId, {
      controller: new AbortController(),
      sessionId: input.sessionId,
      userMessageId: userMessage.id,
      assistantMessageId,
      languages
    })
    const generation: GenerationStarted = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: toConversationMessage({ ...userMessage, retryable: false }),
      assistantMessageId
    }
    const active = this.executions.get(input.requestId)
    if (!active) throw new Error('Explore retry is not registered')
    if (report) {
      void this.retryExploreReply(generation, report, skill, active, emit)
    } else {
      void this.run(
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
    const publish = this.executions.releaseOnTerminal(execution, emit)
    try {
      publish({ type: 'started', ...generation })
      if (execution.controller.signal.aborted) {
        publish({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }
      publish({ ...eventBase, type: 'skillPhase', phase: 'summarizing' })
      await this.persistExploreReply(generation, report, skill, publish)
    } catch (error) {
      const skillId: FileResultSkillId = isExplorePhraseReport(report)
        ? 'explore-phrase'
        : 'explore-vocabulary'
      reportConversationFailure(this.diagnostics, `retry-${skillId}`, requestId, error)
      publish({
        ...eventBase,
        type: 'failed',
        messageId: assistantMessageId,
        error: toConversationEventError(error)
      })
    } finally {
      this.executions.release(requestId, execution)
    }
  }
}

// UUIDv8 derived from the user identity: reply association survives restarts and
// history-window eviction without adding a database column or changing JSON.
// 命名空间按技能区分：词汇回复 ID 与短语回复 ID 不同，避免跨技能碰撞。
export function exploreReplyId(skillId: FileResultSkillId, userMessageId: string): string {
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
