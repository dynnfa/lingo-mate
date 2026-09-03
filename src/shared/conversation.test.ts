import { describe, expect, it } from 'vitest'
import {
  createConversationResultSchema,
  listConversationsResultSchema,
  loadConversationInputSchema,
  loadConversationResultSchema,
  conversationSummarySchema,
  conversationMessageSchema
} from './conversation'

const SESSION_ID = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const MESSAGE_ID = '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708'

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

  it('accepts a conversation message with the current field shape', () => {
    expect(
      conversationMessageSchema.parse({
        id: MESSAGE_ID,
        role: 'assistant',
        content: 'Hi',
        createdAt: '2026-09-01T10:00:01.000Z'
      })
    ).toBeTruthy()
  })

  it('rejects malformed session identifiers', () => {
    expect(loadConversationInputSchema.safeParse({ sessionId: 'not-a-uuid' }).success).toBe(false)
    expect(loadConversationInputSchema.safeParse({}).success).toBe(false)
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
        error: { code: 'PERSISTENCE_ERROR', message: '访问本地会话数据失败，请稍后重试。' }
      }).status
    ).toBe('error')

    const loaded = loadConversationResultSchema.parse({
      status: 'ok',
      conversation: {
        sessionId: SESSION_ID,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:01.000Z'
      },
      messages: [
        {
          id: MESSAGE_ID,
          role: 'user',
          content: 'Hello',
          createdAt: '2026-09-01T10:00:00.500Z'
        }
      ]
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
})
