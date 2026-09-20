import { SynonymError } from '../core/learning/synonym/parse-synonym-input'
import { ExplorePhraseError } from '../core/learning/explore-phrase/explore-phrase-error'
import { ModelConfigValidationError, ModelNotConfiguredError } from '../core/llm/model-config'
import { ModelRequestError } from '../core/llm/llm-client'
import {
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationPersistenceError,
  MessageNotFoundError,
  RequestBusyError,
  RequestNotFoundError,
  RetryNotAllowedError
} from '../core/conversation/conversation-repository'
import { SkillLanguageMismatchError } from '../core/conversation/conversation-module'
import type { ConversationRequestError } from '../shared/conversation'

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留错误码与受约束的
// 判别字段，不携带内部原因和展示文案；文案由 Renderer 翻译。
export function toSafeRequestError(error: unknown): ConversationRequestError {
  if (error instanceof ConversationNotFoundError) {
    return { code: 'NOT_FOUND', resource: 'conversation' }
  }

  if (error instanceof MessageNotFoundError) {
    return { code: 'NOT_FOUND', resource: 'message' }
  }

  if (error instanceof SynonymError && error.code === 'INVALID_INPUT')
    return { code: 'INVALID_INPUT' }

  // /explore-phrase 的历史文件类失败按持久化错误反馈；通信与配置类沿用各自
  // 安全码，其余（生成失败、协议耗尽等）归入模型错误。
  if (error instanceof ExplorePhraseError) {
    if (
      error.code === 'STORAGE_FAILED' ||
      error.code === 'HISTORY_UNREADABLE' ||
      error.code === 'HISTORY_MODIFIED' ||
      error.code === 'RECOVERY_PENDING'
    ) {
      return { code: 'PERSISTENCE_ERROR' }
    }
    if (error.code === 'MODEL_NOT_CONFIGURED') return { code: 'MODEL_NOT_CONFIGURED' }
    if (error.code === 'CREDENTIAL_DECRYPT_FAILED') return { code: 'CREDENTIAL_DECRYPT_FAILED' }
    // TOOL_CALL_NOT_SUPPORTED 只出现在生成事件错误中；请求拒绝路径归入模型错误。
    return { code: 'MODEL_ERROR' }
  }

  if (error instanceof SkillLanguageMismatchError) {
    return { code: 'INVALID_INPUT' }
  }

  if (error instanceof ConversationBusyError) {
    return { code: 'CONVERSATION_BUSY' }
  }

  if (error instanceof RetryNotAllowedError) {
    return { code: 'RETRY_NOT_ALLOWED' }
  }

  if (error instanceof RequestBusyError) {
    return { code: 'REQUEST_BUSY' }
  }

  if (error instanceof RequestNotFoundError) {
    return { code: 'REQUEST_NOT_FOUND' }
  }

  if (error instanceof ConversationPersistenceError) {
    return { code: 'PERSISTENCE_ERROR' }
  }

  if (error instanceof ModelNotConfiguredError) return { code: 'MODEL_NOT_CONFIGURED' }
  if (error instanceof ModelConfigValidationError && error.code === 'CREDENTIAL_DECRYPT_FAILED') {
    return { code: 'CREDENTIAL_DECRYPT_FAILED' }
  }
  if (error instanceof ModelRequestError) return { code: 'MODEL_ERROR' }
  if (error instanceof Error && error.name === 'AbortError') return { code: 'CANCELLED' }
  return { code: 'UNKNOWN_ERROR' }
}
