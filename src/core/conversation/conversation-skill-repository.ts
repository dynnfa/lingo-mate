import type { SynonymBatch } from '../../shared/synonym'
import type { TtsReport } from '../../shared/speech'
import type { SupportedLocale } from '../../shared/preferences'
import type { RunConversationSkillInput } from '../../shared/conversation'
import type { VocabularyBatch } from '../../shared/vocabulary'
import type { PhraseBatch } from '../../shared/phrase'
import type { StoredConversation, StoredMessage } from './conversation-repository'

export type ConversationSkillPhase =
  | 'started'
  | 'analyzing'
  | 'committing'
  | 'summarizing'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'description_failed'
  | 'description_cancelled'

interface StoredSkillExecutionBase {
  id: string
  sessionId: string
  userMessageId: string
  assistantMessageId?: string
  arguments: RunConversationSkillInput['arguments']
  explanationLanguage: SupportedLocale
  phase: ConversationSkillPhase
  createdAt: string
  updatedAt: string
}

// 技能执行按 skillId 判别：报告结构与后续分派依赖该字段，不混用各技能的报告。
export type StoredConversationSkillExecution =
  | (StoredSkillExecutionBase & { skillId: 'tts'; batch?: TtsReport })
  | (StoredSkillExecutionBase & { skillId: 'vocabulary'; batch?: VocabularyBatch })
  | (StoredSkillExecutionBase & { skillId: 'phrase'; batch?: PhraseBatch })
  | (StoredSkillExecutionBase & { skillId: 'synonym'; batch?: SynonymBatch })

export interface ConversationSkillRepository {
  // The visible user message and its typed invocation are one durable fact.
  createExecution(
    execution: StoredConversationSkillExecution,
    userMessage: StoredMessage,
    conversation?: StoredConversation
  ): Promise<void>
  findExecutionByUserMessage(
    sessionId: string,
    userMessageId: string
  ): Promise<StoredConversationSkillExecution | undefined>
  setExecutionPhase(executionId: string, phase: ConversationSkillPhase): Promise<void>
  // The assistant message and final execution state are persisted atomically.
  finishExecution(
    executionId: string,
    phase: 'completed' | 'description_failed' | 'description_cancelled',
    assistantMessage: StoredMessage
  ): Promise<void>
}
