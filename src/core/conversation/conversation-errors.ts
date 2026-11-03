import { SpeechError } from '../speech/speech-synthesizer'
import { AgentRuntimeError } from '../agent/agent-runtime'
import type { CoreDiagnostics } from '../error-diagnostics'
import type { GenerationEventError } from '../../shared/conversation'
import { SynonymError } from '../learning/synonym/parse-synonym-input'
import { VocabularyError } from '../learning/vocabulary/parse-vocabulary-input'
import { SentenceError } from '../learning/sentence/sentence-repository'
import { PhraseError } from '../learning/phrase/parse-phrase-input'
import { ExplorePhraseError } from '../learning/explore-phrase/explore-phrase-error'
import { ExploreVocabularyError } from '../learning/explore-vocabulary/explore-vocabulary-error'
import { ModelConfigValidationError, ModelNotConfiguredError } from '../llm/model-config'
import { ConversationNotFoundError, ConversationPersistenceError } from './conversation-repository'

export function reportConversationFailure(
  diagnostics: CoreDiagnostics,
  operation: string,
  requestId: string,
  error: unknown
): void {
  try {
    diagnostics.report({
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

export async function withConversationPersistence<T>(operation: () => Promise<T>): Promise<T> {
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
export function toConversationEventError(error: unknown): GenerationEventError {
  if (error instanceof SentenceError) {
    if (error.code === 'STORAGE_FAILED') return { code: 'PERSISTENCE_ERROR' }
    return {
      code: error.code === 'MODEL_NOT_CONFIGURED' ? 'MODEL_NOT_CONFIGURED' : 'MODEL_ERROR'
    }
  }
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
