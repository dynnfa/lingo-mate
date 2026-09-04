import {
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationPersistenceError,
  MessageNotFoundError,
  RequestBusyError,
  RequestNotFoundError,
  RetryNotAllowedError
} from '../core/conversation/conversation-repository'
import type { ConversationRequestError } from '../shared/conversation'

// 在进程边界把 Core 错误转换为对用户安全的结构，不保留内部原因。
export function toSafeRequestError(error: unknown): ConversationRequestError {
  if (error instanceof ConversationNotFoundError) {
    return { code: 'NOT_FOUND', message: '会话不存在或已被删除。' }
  }

  if (error instanceof MessageNotFoundError) {
    return { code: 'NOT_FOUND', message: '消息不存在或已被删除。' }
  }

  if (error instanceof ConversationBusyError) {
    return { code: 'CONVERSATION_BUSY', message: '该会话正在生成回复，请稍候。' }
  }

  if (error instanceof RetryNotAllowedError) {
    return { code: 'RETRY_NOT_ALLOWED', message: '这条消息当前无法重试。' }
  }

  if (error instanceof RequestBusyError) {
    return { code: 'REQUEST_BUSY', message: '该回复请求已在处理中。' }
  }

  if (error instanceof RequestNotFoundError) {
    return { code: 'REQUEST_NOT_FOUND', message: '没有找到进行中的回复请求。' }
  }

  if (error instanceof ConversationPersistenceError) {
    return { code: 'PERSISTENCE_ERROR', message: '访问本地会话数据失败，请稍后重试。' }
  }

  return { code: 'UNKNOWN_ERROR', message: '发生未知错误，请稍后重试。' }
}
