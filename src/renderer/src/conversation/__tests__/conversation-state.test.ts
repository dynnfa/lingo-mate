import { describe, expect, it } from 'vitest'
import type { ConversationEvent, ConversationMessage } from '../../../../shared/conversation'
import {
  initialConversationState,
  isGenerating,
  reduceConversation,
  type ConversationState,
  type DisplayMessage
} from '../conversation-state'

const SESSION_A = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const SESSION_B = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'
const REQUEST_ID = '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708'
const OTHER_REQUEST_ID = '44316d8e-c6fb-4d09-bcb8-56936a14932d'
const USER_MESSAGE_ID = '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5'
const ASSISTANT_MESSAGE_ID = 'b6dcfbcf-8dde-4170-b26f-81105b2ef7fb'

const generation = {
  requestId: REQUEST_ID,
  sessionId: SESSION_A,
  userMessage: {
    messageId: USER_MESSAGE_ID,
    sessionId: SESSION_A,
    role: 'user' as const,
    content: 'Hello',
    createdAt: '2026-09-02T09:59:00.000Z'
  },
  assistantMessageId: ASSISTANT_MESSAGE_ID
}

function loadedState(
  messages: ConversationMessage[] = [],
  sessionId = SESSION_A
): ConversationState {
  return reduceConversation(initialConversationState, {
    type: 'conversationLoaded',
    sessionId,
    messages
  })
}

function messageIds(state: ConversationState): string[] {
  return state.messages.map((message) => message.messageId)
}

function findMessage(state: ConversationState, messageId: string): DisplayMessage | undefined {
  return state.messages.find((message) => message.messageId === messageId)
}

describe('conversation projection reducer', () => {
  describe('generation start', () => {
    it('upserts the canonical user message and assistant draft from the started event', () => {
      const state = reduceConversation(loadedState(), {
        type: 'generationEvent',
        event: { type: 'started', ...generation }
      })

      expect(messageIds(state)).toEqual([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID])
      expect(findMessage(state, ASSISTANT_MESSAGE_ID)).toMatchObject({
        role: 'assistant',
        content: '',
        streaming: true
      })
      expect(isGenerating(state)).toBe(true)
      expect(state.status).toEqual({ kind: 'generating' })
    })

    it('merges send result and started event idempotently in either order', () => {
      const viaResultFirst = reduceConversation(
        reduceConversation(loadedState(), { type: 'generationStarted', generation }),
        { type: 'generationEvent', event: { type: 'started', ...generation } }
      )
      const viaEventFirst = reduceConversation(
        reduceConversation(loadedState(), {
          type: 'generationEvent',
          event: { type: 'started', ...generation }
        }),
        { type: 'generationStarted', generation }
      )

      expect(viaResultFirst).toEqual(viaEventFirst)
      expect(messageIds(viaResultFirst)).toEqual([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID])
      expect(Object.keys(viaResultFirst.activeRequests)).toEqual([REQUEST_ID])
    })

    it('ignores generations for another session', () => {
      const state = reduceConversation(loadedState(), {
        type: 'generationStarted',
        generation: { ...generation, sessionId: SESSION_B }
      })

      expect(state.messages).toHaveLength(0)
      expect(isGenerating(state)).toBe(false)
    })

    it('tracks the load phase with a semantic status', () => {
      const restoring = reduceConversation(loadedState(), {
        type: 'loadPhaseStarted',
        status: { kind: 'restoring' }
      })
      expect(restoring.phase).toBe('loading')
      expect(restoring.status).toEqual({ kind: 'restoring' })

      const switching = reduceConversation(loadedState(), {
        type: 'loadPhaseStarted',
        status: { kind: 'switching' }
      })
      expect(switching.status).toEqual({ kind: 'switching' })

      const creating = reduceConversation(loadedState(), {
        type: 'loadPhaseStarted',
        status: { kind: 'creating' }
      })
      expect(creating.status).toEqual({ kind: 'creating' })
    })
  })

  describe('chunk', () => {
    it('appends deltas to the assistant draft carrying the canonical messageId', () => {
      let state = reduceConversation(loadedState(), {
        type: 'generationEvent',
        event: { type: 'started', ...generation }
      })
      state = reduceConversation(state, {
        type: 'generationEvent',
        event: {
          type: 'chunk',
          requestId: REQUEST_ID,
          sessionId: SESSION_A,
          messageId: ASSISTANT_MESSAGE_ID,
          delta: 'Hi'
        }
      })
      state = reduceConversation(state, {
        type: 'generationEvent',
        event: {
          type: 'chunk',
          requestId: REQUEST_ID,
          sessionId: SESSION_A,
          messageId: ASSISTANT_MESSAGE_ID,
          delta: ' there'
        }
      })

      expect(findMessage(state, ASSISTANT_MESSAGE_ID)).toMatchObject({
        content: 'Hi there',
        streaming: true
      })
    })

    it('ignores chunks for an unknown request', () => {
      let state = reduceConversation(loadedState(), {
        type: 'generationEvent',
        event: { type: 'started', ...generation }
      })
      state = reduceConversation(state, {
        type: 'generationEvent',
        event: {
          type: 'chunk',
          requestId: OTHER_REQUEST_ID,
          sessionId: SESSION_A,
          messageId: ASSISTANT_MESSAGE_ID,
          delta: 'stale'
        }
      })

      expect(findMessage(state, ASSISTANT_MESSAGE_ID)?.content).toBe('')
    })

    it('reports a protocol error without touching messages when the chunk identity mismatches', () => {
      let state = reduceConversation(loadedState(), {
        type: 'generationEvent',
        event: { type: 'started', ...generation }
      })
      state = reduceConversation(state, {
        type: 'generationEvent',
        event: {
          type: 'chunk',
          requestId: REQUEST_ID,
          sessionId: SESSION_A,
          messageId: '7b097553-e4fb-48c9-be81-e25cfa55358e',
          delta: 'poison'
        }
      })

      expect(state.status).toEqual({ kind: 'protocolError' })
      expect(findMessage(state, ASSISTANT_MESSAGE_ID)?.content).toBe('')
      expect(findMessage(state, '7b097553-e4fb-48c9-be81-e25cfa55358e')).toBeUndefined()
    })
  })

  describe('completed', () => {
    const completedEvent: ConversationEvent = {
      type: 'completed',
      requestId: REQUEST_ID,
      sessionId: SESSION_A,
      message: {
        messageId: ASSISTANT_MESSAGE_ID,
        sessionId: SESSION_A,
        role: 'assistant',
        content: 'Hi there',
        createdAt: '2026-09-02T10:00:00.000Z'
      }
    }

    function startedWithChunks(): ConversationState {
      const state = reduceConversation(loadedState(), {
        type: 'generationEvent',
        event: { type: 'started', ...generation }
      })
      return reduceConversation(state, {
        type: 'generationEvent',
        event: {
          type: 'chunk',
          requestId: REQUEST_ID,
          sessionId: SESSION_A,
          messageId: ASSISTANT_MESSAGE_ID,
          delta: 'partial'
        }
      })
    }

    it('reconciles the draft in place with the persisted message and keeps one assistant entry', () => {
      const state = reduceConversation(startedWithChunks(), {
        type: 'generationEvent',
        event: completedEvent
      })

      // 原位替换：canonical key 不变，没有旧占位或重复消息
      expect(messageIds(state)).toEqual([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID])
      expect(findMessage(state, ASSISTANT_MESSAGE_ID)).toMatchObject({
        content: 'Hi there',
        streaming: false,
        retryable: false
      })
      expect(isGenerating(state)).toBe(false)
      expect(state.status).toEqual({ kind: 'completed' })
    })

    it('ignores duplicate completed and chunks after the terminal event', () => {
      let state = reduceConversation(startedWithChunks(), {
        type: 'generationEvent',
        event: completedEvent
      })
      state = reduceConversation(state, { type: 'generationEvent', event: completedEvent })
      state = reduceConversation(state, {
        type: 'generationEvent',
        event: {
          type: 'chunk',
          requestId: REQUEST_ID,
          sessionId: SESSION_A,
          messageId: ASSISTANT_MESSAGE_ID,
          delta: 'late'
        }
      })

      expect(messageIds(state)).toEqual([USER_MESSAGE_ID, ASSISTANT_MESSAGE_ID])
      expect(findMessage(state, ASSISTANT_MESSAGE_ID)?.content).toBe('Hi there')
    })

    it('rejects a completed message whose identity mismatches the active mapping', () => {
      const state = reduceConversation(startedWithChunks(), {
        type: 'generationEvent',
        event: {
          ...completedEvent,
          message: { ...completedEvent.message, messageId: '7b097553-e4fb-48c9-be81-e25cfa55358e' }
        }
      })

      expect(state.status).toEqual({ kind: 'protocolError' })
      // 非法终态仍进入安全状态：不保留未持久化 draft，user 可以重试。
      expect(messageIds(state)).toEqual([USER_MESSAGE_ID])
      expect(findMessage(state, USER_MESSAGE_ID)).toMatchObject({ retryable: true })
      expect(isGenerating(state)).toBe(false)
    })

    it('keeps deterministic skill facts and marks only the source user retryable', () => {
      const state = reduceConversation(startedWithChunks(), {
        type: 'generationEvent',
        event: {
          ...completedEvent,
          message: { ...completedEvent.message, content: 'Verified vocabulary facts' },
          skillCompletion: 'description_failed',
          retryableUserMessageId: USER_MESSAGE_ID
        }
      })

      expect(findMessage(state, ASSISTANT_MESSAGE_ID)?.content).toBe('Verified vocabulary facts')
      expect(findMessage(state, USER_MESSAGE_ID)?.retryable).toBe(true)
      expect(state.status).toEqual({ kind: 'skillDescriptionFailed', cancelled: false })
      expect(isGenerating(state)).toBe(false)
    })
  })

  describe('cancelled and failed', () => {
    function startedWithPartial(): ConversationState {
      const state = reduceConversation(loadedState(), {
        type: 'generationEvent',
        event: { type: 'started', ...generation }
      })
      return reduceConversation(state, {
        type: 'generationEvent',
        event: {
          type: 'chunk',
          requestId: REQUEST_ID,
          sessionId: SESSION_A,
          messageId: ASSISTANT_MESSAGE_ID,
          delta: 'partial'
        }
      })
    }

    it('cancelled removes the partial draft and marks the user retryable', () => {
      const state = reduceConversation(startedWithPartial(), {
        type: 'generationEvent',
        event: {
          type: 'cancelled',
          requestId: REQUEST_ID,
          sessionId: SESSION_A,
          messageId: ASSISTANT_MESSAGE_ID
        }
      })

      expect(messageIds(state)).toEqual([USER_MESSAGE_ID])
      expect(findMessage(state, USER_MESSAGE_ID)).toMatchObject({ retryable: true })
      expect(isGenerating(state)).toBe(false)
      expect(state.status).toEqual({ kind: 'cancelled' })
    })

    it('failed removes the partial draft and keeps the typed error semantics', () => {
      const state = reduceConversation(startedWithPartial(), {
        type: 'generationEvent',
        event: {
          type: 'failed',
          requestId: REQUEST_ID,
          sessionId: SESSION_A,
          messageId: ASSISTANT_MESSAGE_ID,
          error: { code: 'MODEL_ERROR' }
        }
      })

      expect(messageIds(state)).toEqual([USER_MESSAGE_ID])
      expect(findMessage(state, USER_MESSAGE_ID)).toMatchObject({ retryable: true })
      expect(state.status).toEqual({ kind: 'generationError', error: { code: 'MODEL_ERROR' } })
    })

    it.each(['cancelled', 'failed'] as const)(
      'retires a mismatched %s terminal without leaving a draft',
      (type) => {
        const terminal =
          type === 'cancelled'
            ? {
                type,
                requestId: REQUEST_ID,
                sessionId: SESSION_A,
                messageId: '7b097553-e4fb-48c9-be81-e25cfa55358e'
              }
            : {
                type,
                requestId: REQUEST_ID,
                sessionId: SESSION_A,
                messageId: '7b097553-e4fb-48c9-be81-e25cfa55358e',
                error: { code: 'MODEL_ERROR' as const }
              }
        const state = reduceConversation(startedWithPartial(), {
          type: 'generationEvent',
          event: terminal
        })

        expect(messageIds(state)).toEqual([USER_MESSAGE_ID])
        expect(findMessage(state, USER_MESSAGE_ID)).toMatchObject({ retryable: true })
        expect(state.status).toEqual({ kind: 'protocolError' })
        expect(isGenerating(state)).toBe(false)
      }
    )

    it('ignores a failed event for an unknown request without a draft', () => {
      const state = reduceConversation(loadedState(), {
        type: 'generationEvent',
        event: {
          type: 'failed',
          requestId: REQUEST_ID,
          sessionId: SESSION_A,
          error: { code: 'PERSISTENCE_ERROR' }
        }
      })

      expect(state.messages).toHaveLength(0)
      expect(state.status).toEqual({ kind: 'ready' })
    })

    it('a terminal only clears its own request and leaves other active generations intact', () => {
      let state = reduceConversation(loadedState(), {
        type: 'generationEvent',
        event: { type: 'started', ...generation }
      })
      const otherGeneration = {
        ...generation,
        requestId: OTHER_REQUEST_ID,
        userMessage: {
          ...generation.userMessage,
          messageId: '11111111-1111-4111-8111-111111111111'
        },
        assistantMessageId: '22222222-2222-4222-8222-222222222222'
      }
      state = reduceConversation(state, {
        type: 'generationEvent',
        event: { type: 'started', ...otherGeneration }
      })

      state = reduceConversation(state, {
        type: 'generationEvent',
        event: {
          type: 'cancelled',
          requestId: OTHER_REQUEST_ID,
          sessionId: SESSION_A,
          messageId: otherGeneration.assistantMessageId
        }
      })

      // 只清理自己的请求，另一个生成不受影响
      expect(Object.keys(state.activeRequests)).toEqual([REQUEST_ID])
      expect(messageIds(state)).toEqual([
        USER_MESSAGE_ID,
        ASSISTANT_MESSAGE_ID,
        otherGeneration.userMessage.messageId
      ])
    })
  })

  describe('load and stale isolation', () => {
    it('marks the last unanswered user message retryable after load', () => {
      const state = loadedState([generation.userMessage])

      expect(findMessage(state, USER_MESSAGE_ID)).toMatchObject({ retryable: true })
      expect(isGenerating(state)).toBe(false)
    })

    it('does not mark a user message retryable when an assistant reply follows', () => {
      const state = loadedState([
        generation.userMessage,
        {
          messageId: ASSISTANT_MESSAGE_ID,
          sessionId: SESSION_A,
          role: 'assistant',
          content: 'Hi',
          createdAt: '2026-09-02T10:00:00.000Z'
        }
      ])

      expect(findMessage(state, USER_MESSAGE_ID)?.retryable).toBe(false)
      expect(findMessage(state, ASSISTANT_MESSAGE_ID)?.retryable).toBe(false)
    })

    it('resets active requests on load and ignores events from the previous session', () => {
      let state = reduceConversation(loadedState(), {
        type: 'generationEvent',
        event: { type: 'started', ...generation }
      })
      expect(isGenerating(state)).toBe(true)

      state = reduceConversation(state, {
        type: 'conversationLoaded',
        sessionId: SESSION_B,
        messages: []
      })
      expect(isGenerating(state)).toBe(false)

      state = reduceConversation(state, {
        type: 'generationEvent',
        event: {
          type: 'chunk',
          requestId: REQUEST_ID,
          sessionId: SESSION_A,
          messageId: ASSISTANT_MESSAGE_ID,
          delta: 'stale'
        }
      })

      expect(state.messages).toHaveLength(0)
      expect(state.status).toEqual({ kind: 'ready' })
    })

    it('ignores a late started after the request reached a terminal state', () => {
      let state = reduceConversation(loadedState(), {
        type: 'generationEvent',
        event: { type: 'started', ...generation }
      })
      state = reduceConversation(state, {
        type: 'generationEvent',
        event: {
          type: 'cancelled',
          requestId: REQUEST_ID,
          sessionId: SESSION_A,
          messageId: ASSISTANT_MESSAGE_ID
        }
      })
      state = reduceConversation(state, {
        type: 'generationEvent',
        event: { type: 'started', ...generation }
      })

      expect(messageIds(state)).toEqual([USER_MESSAGE_ID])
      expect(isGenerating(state)).toBe(false)
    })
  })

  describe('command bookkeeping and failure statuses', () => {
    it('tracks a pending command and settles it without polluting messages', () => {
      let state = reduceConversation(loadedState(), { type: 'commandStarted' })
      expect(state.commandPending).toBe(true)

      state = reduceConversation(state, {
        type: 'commandFailed',
        status: { kind: 'ipcError', operation: 'send' }
      })
      expect(state.commandPending).toBe(false)
      expect(state.status).toEqual({ kind: 'ipcError', operation: 'send' })
      expect(state.messages).toHaveLength(0)

      state = reduceConversation(state, { type: 'commandStarted' })
      state = reduceConversation(state, { type: 'commandSettled' })
      expect(state.commandPending).toBe(false)
    })

    it('keeps operation context and typed protocol errors in failure statuses', () => {
      const state = reduceConversation(loadedState(), {
        type: 'recoverFailed',
        status: {
          kind: 'requestError',
          operation: 'load',
          error: { code: 'NOT_FOUND', resource: 'conversation' }
        }
      })

      expect(state.phase).toBe('failed')
      expect(state.status).toEqual({
        kind: 'requestError',
        operation: 'load',
        error: { code: 'NOT_FOUND', resource: 'conversation' }
      })
    })

    it('starts with a semantic restoring status', () => {
      expect(initialConversationState.status).toEqual({ kind: 'restoring' })
      expect(initialConversationState.phase).toBe('loading')
    })
  })
})
