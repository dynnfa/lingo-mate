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
  it('maps typed core errors to safe request errors without display text', () => {
    expect(
      toSafeRequestError(new ConversationNotFoundError('f9364f0f-f3f4-4ea6-a31d-b55754aa2477'))
    ).toEqual({ code: 'NOT_FOUND', resource: 'conversation' })

    expect(
      toSafeRequestError(new MessageNotFoundError('3f70b8ae-7ad9-4eab-aaf4-1cae54a99708'))
    ).toEqual({ code: 'NOT_FOUND', resource: 'message' })

    expect(
      toSafeRequestError(new ConversationBusyError('f9364f0f-f3f4-4ea6-a31d-b55754aa2477'))
    ).toEqual({ code: 'CONVERSATION_BUSY' })

    expect(
      toSafeRequestError(new RetryNotAllowedError('only the last unanswered user message'))
    ).toEqual({ code: 'RETRY_NOT_ALLOWED' })

    expect(
      toSafeRequestError(new RequestBusyError('3f70b8ae-7ad9-4eab-aaf4-1cae54a99708'))
    ).toEqual({ code: 'REQUEST_BUSY' })

    expect(
      toSafeRequestError(new RequestNotFoundError('3f70b8ae-7ad9-4eab-aaf4-1cae54a99708'))
    ).toEqual({ code: 'REQUEST_NOT_FOUND' })

    expect(toSafeRequestError(new ConversationPersistenceError('sqlite is locked'))).toEqual({
      code: 'PERSISTENCE_ERROR'
    })
  })

  it('hides internal details of unexpected errors', () => {
    const error = new Error('SQLITE_CONSTRAINT: database disk image is malformed at /Users/x/db')

    expect(toSafeRequestError(error)).toEqual({ code: 'UNKNOWN_ERROR' })
    expect(toSafeRequestError('not even an error')).toEqual({ code: 'UNKNOWN_ERROR' })
  })
})
