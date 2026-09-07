import { describe, expect, it } from 'vitest'
import { ConversationController } from '../conversation-controller'
import type {
  ConversationApi,
  ConversationSummary,
  ListConversationsResult,
  LoadConversationResult
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
  return { sessionId, createdAt: NOW, updatedAt: NOW }
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
    create: unconfigured('create'),
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
    expect(state.sessionId).toBe(SESSION_B)
    expect(state.conversations.map((conversation) => conversation.sessionId)).toEqual([SESSION_B])
    expect(state.phase).toBe('ready')
  })
})
