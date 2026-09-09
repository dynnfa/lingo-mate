import { describe, expect, it, vi } from 'vitest'
import { ConversationController } from '../conversation-controller'
import type {
  ConversationApi,
  ConversationSummary,
  ListConversationsResult,
  LoadConversationResult,
  SendMessageResult,
  ConversationEvent
} from '../../../../shared/conversation'

const SESSION_A = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const SESSION_B = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'
const SESSION_C = '44316d8e-c6fb-4d09-bcb8-56936a14932d'
const NOW = '2026-09-02T10:00:00.000Z'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function summary(sessionId: string): ConversationSummary {
  return { sessionId, title: null, createdAt: NOW, updatedAt: NOW }
}

function loaded(sessionId: string, contents: string[]): LoadConversationResult {
  return {
    status: 'ok',
    conversation: summary(sessionId),
    messages: contents.map((content, index) => ({
      messageId: `${sessionId}-${index}`,
      sessionId,
      role: 'assistant',
      content,
      createdAt: NOW
    }))
  }
}

function apiStub(overrides: Partial<ConversationApi>): ConversationApi {
  const unconfigured = (name: string) => (): never => {
    throw new Error(`${name} not configured for this test`)
  }
  return {
    create: async () => ({ status: 'ok', conversation: summary(SESSION_A) }),
    list: unconfigured('list'),
    load: unconfigured('load'),
    send: unconfigured('send'),
    runSkill: unconfigured('runSkill'),
    retry: unconfigured('retry'),
    cancel: unconfigured('cancel'),
    onEvent: unconfigured('onEvent'),
    ...overrides
  }
}

describe('ConversationController transitions', () => {
  it('refreshes the list when a background title arrives without changing generation state', async () => {
    let listener!: (event: ConversationEvent) => void
    let title = 'User input'
    const controller = new ConversationController(
      apiStub({
        list: async () => ({ status: 'ok', conversations: [{ ...summary(SESSION_A), title }] }),
        load: async () => loaded(SESSION_A, []),
        onEvent: (callback) => {
          listener = callback
          return () => {}
        }
      })
    )
    controller.attach()
    await controller.initialize()
    const status = controller.getState().status
    title = 'Summarized title'
    listener({ type: 'titleUpdated', sessionId: SESSION_A, requestId: SESSION_B })
    await vi.waitFor(() => expect(controller.getState().conversations[0].title).toBe(title))
    expect(controller.getState().status).toEqual(status)
  })

  it('commits only the latest selection when an earlier load resolves late', async () => {
    const loadB = deferred<LoadConversationResult>()
    const loadC = deferred<LoadConversationResult>()
    const controller = new ConversationController(
      apiStub({
        list: async () => ({
          status: 'ok',
          conversations: [summary(SESSION_A), summary(SESSION_B), summary(SESSION_C)]
        }),
        load: ({ sessionId }) =>
          sessionId === SESSION_B
            ? loadB.promise
            : sessionId === SESSION_C
              ? loadC.promise
              : Promise.resolve(loaded(SESSION_A, ['A 的历史']))
      })
    )
    await controller.initialize()
    expect(controller.getState().sessionId).toBe(SESSION_A)

    // UI 会禁用侧栏按钮，但守卫契约不依赖 DOM 禁用：并发切换时只有最后一次选择生效。
    const switchB = controller.switchSession(SESSION_B)
    const switchC = controller.switchSession(SESSION_C)

    loadC.resolve(loaded(SESSION_C, ['最新选择']))
    await switchC
    loadB.resolve(loaded(SESSION_B, ['过期选择']))
    await switchB

    const state = controller.getState()
    expect(state.sessionId).toBe(SESSION_C)
    expect(state.messages.map((message) => message.content)).toEqual(['最新选择'])
    expect(state.phase).toBe('ready')
  })

  it('keeps the second recovery when initialize runs twice and the first settles late', async () => {
    const firstList = deferred<ListConversationsResult>()
    const secondList = deferred<ListConversationsResult>()
    let listCalls = 0
    const controller = new ConversationController(
      apiStub({
        create: async () => ({ status: 'ok', conversation: summary(SESSION_C) }),
        list: async () => {
          listCalls += 1
          return listCalls === 1 ? firstList.promise : secondList.promise
        },
        load: ({ sessionId }) => Promise.resolve(loaded(sessionId, [`${sessionId} 的历史`]))
      })
    )

    // StrictMode 下挂载效应会执行两次：两个 initialize 并发，只有后一个生效。
    const first = controller.initialize()
    const second = controller.initialize()

    secondList.resolve({ status: 'ok', conversations: [summary(SESSION_B)] })
    await second
    firstList.resolve({ status: 'ok', conversations: [summary(SESSION_A), summary(SESSION_C)] })
    await first

    const state = controller.getState()
    expect(state.sessionId).toBe(SESSION_C)
    expect(state.conversations.map((conversation) => conversation.sessionId)).toEqual([SESSION_B])
    expect(state.phase).toBe('ready')
  })
})

describe('draft conversation lifecycle', () => {
  it('keeps drafts out of the list and can cancel a pending title request', async () => {
    const result = deferred<SendMessageResult>()
    let requestId: string | undefined
    let cancelled: string | undefined
    const controller = new ConversationController(
      apiStub({
        list: async () => ({ status: 'ok', conversations: [] }),
        create: async () => ({ status: 'ok', conversation: summary(SESSION_A) }),
        load: async () => loaded(SESSION_A, []),
        send: (input) => {
          requestId = input.requestId
          return result.promise
        },
        cancel: async (input) => {
          cancelled = input.requestId
          return { status: 'ok' }
        }
      })
    )
    await controller.initialize()
    expect(controller.getState().conversations).toEqual([])
    const pending = controller.send('Coffee')
    expect(controller.getState().status).toEqual({ kind: 'generatingTitle' })
    await controller.cancel()
    expect(cancelled).toBe(requestId)
    result.resolve({ status: 'error', error: { code: 'CANCELLED' } })
    expect(await pending).toBe(false)
    expect(controller.getState().commandPending).toBe(false)
    expect(controller.getState().messages).toEqual([])
  })

  it('refreshes titles when the first message is persisted even if its reply fails', async () => {
    let listener!: (event: ConversationEvent) => void
    let persisted = false
    const controller = new ConversationController(
      apiStub({
        list: async () => ({
          status: 'ok',
          conversations: persisted ? [{ ...summary(SESSION_A), title: 'Coffee practice' }] : []
        }),
        create: async () => ({ status: 'ok', conversation: summary(SESSION_A) }),
        load: async () => loaded(SESSION_A, []),
        onEvent: (onEvent) => {
          listener = onEvent
          return () => {}
        }
      })
    )
    controller.attach()
    await controller.initialize()
    persisted = true
    listener({
      type: 'started',
      requestId: SESSION_B,
      sessionId: SESSION_A,
      userMessage: {
        messageId: SESSION_C,
        sessionId: SESSION_A,
        role: 'user',
        content: 'Coffee',
        createdAt: NOW
      },
      assistantMessageId: 'assistant'
    })
    listener({
      type: 'failed',
      requestId: SESSION_B,
      sessionId: SESSION_A,
      messageId: 'assistant',
      error: { code: 'MODEL_ERROR' }
    })
    await Promise.resolve()
    expect(controller.getState().conversations[0]?.title).toBe('Coffee practice')
  })
})
