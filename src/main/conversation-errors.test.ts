import { describe, expect, it } from 'vitest'
import {
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationPersistenceError,
  MessageNotFoundError,
  RequestBusyError,
  RequestNotFoundError,
  RetryNotAllowedError
} from '../core/conversation/conversation-repository'
import { toSafeRequestError } from './conversation-errors'

describe('conversation error boundary mapping', () => {
  it('maps typed core errors to safe request errors', () => {
    expect(
      toSafeRequestError(new ConversationNotFoundError('f9364f0f-f3f4-4ea6-a31d-b55754aa2477'))
    ).toEqual({ code: 'NOT_FOUND', message: '会话不存在或已被删除。' })

    expect(
      toSafeRequestError(new MessageNotFoundError('3f70b8ae-7ad9-4eab-aaf4-1cae54a99708'))
    ).toEqual({ code: 'NOT_FOUND', message: '消息不存在或已被删除。' })

    expect(
      toSafeRequestError(new ConversationBusyError('f9364f0f-f3f4-4ea6-a31d-b55754aa2477'))
    ).toEqual({ code: 'CONVERSATION_BUSY', message: '该会话正在生成回复，请稍候。' })

    expect(
      toSafeRequestError(new RetryNotAllowedError('only the last unanswered user message'))
    ).toEqual({ code: 'RETRY_NOT_ALLOWED', message: '这条消息当前无法重试。' })

    expect(
      toSafeRequestError(new RequestBusyError('3f70b8ae-7ad9-4eab-aaf4-1cae54a99708'))
    ).toEqual({ code: 'REQUEST_BUSY', message: '该回复请求已在处理中。' })

    expect(
      toSafeRequestError(new RequestNotFoundError('3f70b8ae-7ad9-4eab-aaf4-1cae54a99708'))
    ).toEqual({
      code: 'REQUEST_NOT_FOUND',
      message: '没有找到进行中的回复请求。'
    })

    expect(toSafeRequestError(new ConversationPersistenceError('sqlite is locked'))).toEqual({
      code: 'PERSISTENCE_ERROR',
      message: '访问本地会话数据失败，请稍后重试。'
    })
  })

  it('hides internal details of unexpected errors', () => {
    const error = new Error('SQLITE_CONSTRAINT: database disk image is malformed at /Users/x/db')

    expect(toSafeRequestError(error)).toEqual({
      code: 'UNKNOWN_ERROR',
      message: '发生未知错误，请稍后重试。'
    })
    expect(toSafeRequestError('not even an error')).toEqual({
      code: 'UNKNOWN_ERROR',
      message: '发生未知错误，请稍后重试。'
    })
  })
})
