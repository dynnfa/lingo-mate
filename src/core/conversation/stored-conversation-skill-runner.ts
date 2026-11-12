import { randomUUID } from 'node:crypto'
import type {
  ConversationSkillId,
  ConversationSkillReport,
  GenerationAccepted,
  GenerationStarted,
  RetryMessageInput,
  RunConversationSkillInput
} from '../../shared/conversation'
import { isTtsReport } from '../../shared/speech'
import { noopCoreDiagnostics, type CoreDiagnostics } from '../error-diagnostics'
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
  type StoredConversation,
  type StoredMessage
} from './conversation-repository'
import type { ConversationSkill, ConversationSkillRunInput } from './conversation-skill'
import type {
  ConversationSkillRepository,
  StoredConversationSkillExecution
} from './conversation-skill-repository'

type StoredSkillInput = Extract<
  RunConversationSkillInput,
  { skillId: StoredConversationSkillExecution['skillId'] }
>

// SQLite 执行记录与回复原子提交；完整报告只恢复反馈，未完成近义词报告继续执行。
export class StoredConversationSkillRunner {
  constructor(
    private readonly repository: ConversationSkillRepository,
    private readonly skills: ReadonlyMap<ConversationSkillId, ConversationSkill>,
    private readonly executions: ConversationExecutions,
    private readonly diagnostics: CoreDiagnostics = noopCoreDiagnostics
  ) {}

  async create(
    input: StoredSkillInput,
    userMessage: StoredMessage,
    languages: ConversationLanguages,
    conversation?: StoredConversation
  ): Promise<StoredConversationSkillExecution> {
    const now = userMessage.createdAt
    // 数据库技能共享执行元数据；skillId 字面量决定报告判别类型。
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
      input.skillId === 'sentence'
        ? { ...executionBase, skillId: 'sentence' }
        : input.skillId === 'tts'
          ? { ...executionBase, skillId: 'tts' }
          : input.skillId === 'synonym'
            ? { ...executionBase, skillId: 'synonym' }
            : input.skillId === 'phrase'
              ? { ...executionBase, skillId: 'phrase' }
              : { ...executionBase, skillId: 'vocabulary' }
    await withConversationPersistence(() =>
      this.repository.createExecution(execution, userMessage, conversation)
    )
    return execution
  }

  async retry(
    input: RetryMessageInput,
    userMessage: StoredMessage,
    emit: ConversationEventListener
  ): Promise<GenerationAccepted | undefined> {
    const skillExecution = await withConversationPersistence(() =>
      this.repository.findExecutionByUserMessage(input.sessionId, input.userMessageId)
    )
    if (skillExecution) {
      const skill = this.skills.get(skillExecution.skillId)
      if (!skill || skillExecution.phase === 'completed') {
        throw new RetryNotAllowedError('skill execution cannot be retried')
      }
      const assistantMessageId = randomUUID()
      // 已持久化的技能重试沿用原执行参数和解释语言；不读取当前设置。
      this.executions.register(input.requestId, {
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
        userMessage: toConversationMessage({ ...userMessage, retryable: false }),
        assistantMessageId
      }
      const active = this.executions.get(input.requestId)
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
        void this.run(generation, skillExecution, skill, active, emit)
      }
      return { accepted: true, generation }
    }

    return undefined
  }

  async run(
    generation: GenerationStarted,
    skillExecution: StoredConversationSkillExecution,
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
        await this.repository.setExecutionPhase(skillExecution.id, 'cancelled')
        publish({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
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
          await this.repository.setExecutionPhase(skillExecution.id, phase)
          publish({ ...eventBase, type: 'skillPhase', phase })
        }
      } satisfies ConversationSkillRunInput)

      if (result.outcome === 'cancelled') {
        await this.repository.setExecutionPhase(skillExecution.id, 'cancelled')
        publish({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }
      await this.persistSkillReply(generation, skillExecution, result.report, skill, publish)
    } catch (error) {
      if (execution.controller.signal.aborted) {
        try {
          await this.repository.setExecutionPhase(skillExecution.id, 'cancelled')
          publish({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        } catch (persistenceError) {
          reportConversationFailure(
            this.diagnostics,
            'set-cancelled-phase',
            requestId,
            persistenceError
          )
          publish({
            ...eventBase,
            type: 'failed',
            messageId: assistantMessageId,
            error: toConversationEventError(persistenceError)
          })
        }
      } else {
        reportConversationFailure(this.diagnostics, 'run-skill', requestId, error)
        try {
          await this.repository.setExecutionPhase(skillExecution.id, 'failed')
        } catch (persistenceError) {
          reportConversationFailure(
            this.diagnostics,
            'set-failed-phase',
            requestId,
            persistenceError
          )
          // 对外仍返回原始业务错误；二次持久化失败仅进入内部日志。
        }
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
    const publish = this.executions.releaseOnTerminal(execution, emit)
    try {
      publish({ type: 'started', ...generation })
      if (execution.controller.signal.aborted) {
        await this.repository.setExecutionPhase(skillExecution.id, 'cancelled')
        publish({ ...eventBase, type: 'cancelled', messageId: assistantMessageId })
        return
      }
      await this.repository.setExecutionPhase(skillExecution.id, 'summarizing')
      publish({ ...eventBase, type: 'skillPhase', phase: 'summarizing' })
      await this.persistSkillReply(generation, skillExecution, report, skill, publish)
    } catch (error) {
      reportConversationFailure(this.diagnostics, 'retry-skill-reply', requestId, error)
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
    await withConversationPersistence(() =>
      this.repository.finishExecution(skillExecution.id, 'completed', assistantMessage)
    )
    emit({
      requestId: generation.requestId,
      sessionId: generation.sessionId,
      type: 'completed',
      message: toConversationMessage(assistantMessage),
      skillCompletion: 'complete'
    })
  }
}
