import { describe, expect, it } from 'vitest'
import {
  ConversationNotFoundError,
  ConversationPersistenceError
} from '../core/conversation/conversation-repository'
import { toSafeIpcError, toSafeRequestError } from './conversation-errors'

describe('conversation error boundary mapping', () => {
  it('maps typed core errors to safe request errors', () => {
    expect(
      toSafeRequestError(new ConversationNotFoundError('f9364f0f-f3f4-4ea6-a31d-b55754aa2477'))
    ).toEqual({ code: 'NOT_FOUND', message: '会话不存在或已被删除。' })

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

  it('produces ipc errors that carry only the safe message', () => {
    const ipcError = toSafeIpcError(
      new ConversationPersistenceError('details with table names and paths')
    )

    expect(ipcError).toBeInstanceOf(Error)
    expect(ipcError.message).toBe('访问本地会话数据失败，请稍后重试。')
  })
})
