import { describe, expect, it } from 'vitest'
import {
  cancelMessageInputSchema,
  cancelMessageResultSchema,
  conversationEventSchema,
  conversationMessageSchema,
  conversationSummarySchema,
  createConversationResultSchema,
  generationStartedSchema,
  listConversationsResultSchema,
  loadConversationInputSchema,
  loadConversationResultSchema,
  retryMessageInputSchema,
  sendMessageResultSchema
} from './conversation'

const SESSION_ID = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const REQUEST_ID = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'
const USER_MESSAGE_ID = '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708'
const ASSISTANT_MESSAGE_ID = '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5'

const USER_MESSAGE = {
  messageId: USER_MESSAGE_ID,
  sessionId: SESSION_ID,
  role: 'user',
  content: 'Hello',
  createdAt: '2026-09-01T10:00:00.500Z'
}

const GENERATION = {
  requestId: REQUEST_ID,
  sessionId: SESSION_ID,
  userMessage: USER_MESSAGE,
  assistantMessageId: ASSISTANT_MESSAGE_ID
}

describe('conversation protocol schemas', () => {
  it('accepts a persisted conversation summary', () => {
    expect(
      conversationSummarySchema.parse({
        sessionId: SESSION_ID,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:01.000Z'
      })
    ).toBeTruthy()
  })

  it('accepts a conversation message keyed by canonical messageId', () => {
    expect(conversationMessageSchema.parse(USER_MESSAGE)).toBeTruthy()
  })

  it('rejects malformed session identifiers', () => {
    expect(loadConversationInputSchema.safeParse({ sessionId: 'not-a-uuid' }).success).toBe(false)
    expect(loadConversationInputSchema.safeParse({}).success).toBe(false)
  })

  it('parses the canonical generation payload shared by send result and started event', () => {
    expect(generationStartedSchema.parse(GENERATION)).toEqual(GENERATION)

    const sent = sendMessageResultSchema.parse({
      status: 'ok',
      accepted: true,
      generation: GENERATION
    })
    expect(sent).toMatchObject({ status: 'ok', accepted: true })

    const retried = sendMessageResultSchema.parse({
      status: 'ok',
      accepted: true,
      generation: GENERATION
    })
    expect(retried.status).toBe('ok')
  })

  it('rejects generation payloads that are not uuid identities', () => {
    expect(
      generationStartedSchema.safeParse({ ...GENERATION, assistantMessageId: 'request-1' }).success
    ).toBe(false)
    expect(
      sendMessageResultSchema.safeParse({
        status: 'ok',
        accepted: true,
        generation: { ...GENERATION, userMessage: { ...USER_MESSAGE, role: 'system' } }
      }).success
    ).toBe(false)
  })

  it('validates retry and cancel inputs', () => {
    expect(
      retryMessageInputSchema.safeParse({
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        userMessageId: USER_MESSAGE_ID
      }).success
    ).toBe(true)
    expect(retryMessageInputSchema.safeParse({ requestId: REQUEST_ID }).success).toBe(false)
    expect(cancelMessageInputSchema.safeParse({ requestId: REQUEST_ID }).success).toBe(true)
    expect(cancelMessageInputSchema.safeParse({ requestId: 'nope' }).success).toBe(false)
  })

  it('maps structured cancel results', () => {
    expect(cancelMessageResultSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' })
    expect(
      cancelMessageResultSchema.parse({
        status: 'error',
        error: { code: 'REQUEST_NOT_FOUND', message: '没有找到可取消的回复请求。' }
      })
    ).toBeTruthy()
    expect(
      cancelMessageResultSchema.safeParse({
        status: 'error',
        error: { code: 'SQLITE_ERROR', message: 'raw' }
      }).success
    ).toBe(false)
  })

  it('parses ok and error results of the lifecycle operations', () => {
    expect(
      createConversationResultSchema.parse({
        status: 'ok',
        conversation: {
          sessionId: SESSION_ID,
          createdAt: '2026-09-01T10:00:00.000Z',
          updatedAt: '2026-09-01T10:00:00.000Z'
        }
      }).status
    ).toBe('ok')

    expect(
      listConversationsResultSchema.parse({
        status: 'error',
        error: { code: 'REQUEST_BUSY', message: '该回复请求已在处理中。' }
      }).status
    ).toBe('error')

    const loaded = loadConversationResultSchema.parse({
      status: 'ok',
      conversation: {
        sessionId: SESSION_ID,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:01.000Z'
      },
      messages: [USER_MESSAGE]
    })

    expect(loaded.status).toBe('ok')
    if (loaded.status === 'ok') {
      expect(loaded.messages).toHaveLength(1)
    }
  })

  it('rejects result payloads with unknown error codes', () => {
    expect(
      createConversationResultSchema.safeParse({
        status: 'error',
        error: { code: 'SQLITE_ERROR', message: 'raw' }
      }).success
    ).toBe(false)
  })

  it('requires canonical message identity on every streaming event', () => {
    expect(
      conversationEventSchema.parse({
        type: 'started',
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        userMessage: USER_MESSAGE,
        assistantMessageId: ASSISTANT_MESSAGE_ID
      })
    ).toBeTruthy()

    expect(
      conversationEventSchema.parse({
        type: 'chunk',
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        messageId: ASSISTANT_MESSAGE_ID,
        delta: 'Hi'
      })
    ).toBeTruthy()

    expect(
      conversationEventSchema.parse({
        type: 'completed',
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        message: {
          messageId: ASSISTANT_MESSAGE_ID,
          sessionId: SESSION_ID,
          role: 'assistant',
          content: 'Hi there',
          createdAt: '2026-09-01T10:00:02.000Z'
        }
      })
    ).toBeTruthy()

    expect(
      conversationEventSchema.parse({
        type: 'cancelled',
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        messageId: ASSISTANT_MESSAGE_ID
      })
    ).toBeTruthy()

    // user 持久化前失败时没有 assistant 身份可携带
    expect(
      conversationEventSchema.parse({
        type: 'failed',
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        error: { code: 'PERSISTENCE_ERROR', message: '保存会话失败，请稍后重试。' }
      })
    ).toBeTruthy()

    expect(
      conversationEventSchema.parse({
        type: 'failed',
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        messageId: ASSISTANT_MESSAGE_ID,
        error: { code: 'MODEL_ERROR', message: '生成回复失败，请稍后重试。' }
      })
    ).toBeTruthy()
  })

  it('rejects legacy events that lack canonical message identity', () => {
    // 旧协议的 completed 只有 messageId 字符串、chunk 无身份，均应被拒绝
    expect(
      conversationEventSchema.safeParse({
        type: 'chunk',
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        delta: 'Hi'
      }).success
    ).toBe(false)

    expect(
      conversationEventSchema.safeParse({
        type: 'completed',
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        messageId: ASSISTANT_MESSAGE_ID
      }).success
    ).toBe(false)
  })
})
