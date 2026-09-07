import type { SupportedLocale } from '../../shared/preferences'
import type { RunConversationSkillInput } from '../../shared/conversation'
import type { VocabularyBatch } from '../../shared/vocabulary'
import type { StoredMessage } from './conversation-repository'

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

export interface StoredConversationSkillExecution {
  id: string
  sessionId: string
  userMessageId: string
  assistantMessageId?: string
  skillId: 'vocabulary'
  arguments: RunConversationSkillInput['arguments']
  explanationLanguage: SupportedLocale
  phase: ConversationSkillPhase
  batch?: VocabularyBatch
  createdAt: string
  updatedAt: string
}

export interface ConversationSkillRepository {
  // The visible user message and its typed invocation are one durable fact.
  createExecution(
    execution: StoredConversationSkillExecution,
    userMessage: StoredMessage
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
