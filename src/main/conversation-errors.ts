import {
  ConversationNotFoundError,
  ConversationPersistenceError
} from '../core/conversation/conversation-repository'
import type { ConversationRequestError } from '../shared/conversation'

// 在进程边界把 Core 错误转换为对用户安全的结构，不保留内部原因。
export function toSafeRequestError(error: unknown): ConversationRequestError {
  if (error instanceof ConversationNotFoundError) {
    return { code: 'NOT_FOUND', message: '会话不存在或已被删除。' }
  }

  if (error instanceof ConversationPersistenceError) {
    return { code: 'PERSISTENCE_ERROR', message: '访问本地会话数据失败，请稍后重试。' }
  }

  return { code: 'UNKNOWN_ERROR', message: '发生未知错误，请稍后重试。' }
}

export function toSafeIpcError(error: unknown): Error {
  return new Error(toSafeRequestError(error).message)
}
