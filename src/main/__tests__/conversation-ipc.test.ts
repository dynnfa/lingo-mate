import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ConversationEventListener,
  ConversationModule
} from '../../core/conversation/conversation-module'
import { RequestNotFoundError } from '../../core/conversation/conversation-repository'
import {
  CONVERSATION_CHANNELS,
  type GenerationAccepted,
  type GenerationStarted,
  type SendMessageInput
} from '../../shared/conversation'
import { registerConversationIpc } from '../conversation-ipc'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import {
  electronMocks,
  FakeSender,
  registeredHandler,
  RENDERER_URL,
  resetIpcMocks
} from './helpers/ipc-test-env'

vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())

const registerTrustedHandler = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })

const REQUEST_ID = '3f70b8ae-7ad9-4eab-aaf4-1cae54aa2477'
const SESSION_ID = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const USER_MESSAGE_ID = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'
const ASSISTANT_MESSAGE_ID = '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5'

const INPUT: SendMessageInput = { requestId: REQUEST_ID, sessionId: SESSION_ID, text: 'Hello' }
const GENERATION: GenerationStarted = {
  requestId: REQUEST_ID,
  sessionId: SESSION_ID,
  userMessage: {
    messageId: USER_MESSAGE_ID,
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Hello',
    createdAt: '2026-09-03T08:00:00.000Z'
  },
  assistantMessageId: ASSISTANT_MESSAGE_ID
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('conversation IPC request ownership', () => {
  beforeEach(resetIpcMocks)

  it('retries cancellation after Core accepts a request whose sender was already destroyed', async () => {
    const accepted = deferred<GenerationAccepted>()
    let coreHasRegisteredRequest = false
    const cancelMessage = vi.fn(() => {
      if (!coreHasRegisteredRequest) throw new RequestNotFoundError(REQUEST_ID)
    })
    const module = {
      sendMessage: vi.fn(() => accepted.promise),
      cancelMessage
    } as unknown as ConversationModule
    registerConversationIpc(module, registerTrustedHandler)

    const sender = new FakeSender()
    const sendResult = registeredHandler(CONVERSATION_CHANNELS.send)({ sender }, INPUT)

    sender.destroy()
    expect(cancelMessage).toHaveBeenCalledTimes(1)

    coreHasRegisteredRequest = true
    accepted.resolve({ accepted: true, generation: GENERATION })
    await expect(sendResult).resolves.toMatchObject({ status: 'ok', accepted: true })
    expect(cancelMessage).toHaveBeenCalledTimes(2)
  })

  it('allows the owning sender to cancel after started but before the send result settles', async () => {
    const accepted = deferred<GenerationAccepted>()
    const cancelMessage = vi.fn()
    const module = {
      sendMessage: vi.fn((_input: SendMessageInput, emit: ConversationEventListener) => {
        emit({ type: 'started', ...GENERATION })
        return accepted.promise
      }),
      cancelMessage
    } as unknown as ConversationModule
    registerConversationIpc(module, registerTrustedHandler)

    const sender = new FakeSender()
    const sendResult = registeredHandler(CONVERSATION_CHANNELS.send)({ sender }, INPUT)
    const cancelResult = registeredHandler(CONVERSATION_CHANNELS.cancel)(
      { sender },
      { requestId: REQUEST_ID }
    )

    expect(cancelResult).toEqual({ status: 'ok' })
    expect(cancelMessage).toHaveBeenCalledWith(REQUEST_ID)

    accepted.resolve({ accepted: true, generation: GENERATION })
    await sendResult
  })

  it('rejects unknown or malformed skill requests before calling Core', async () => {
    const runSkill = vi.fn()
    const module = { runSkill } as unknown as ConversationModule
    registerConversationIpc(module, registerTrustedHandler)
    const sender = new FakeSender()

    expect(
      registeredHandler(CONVERSATION_CHANNELS.runSkill)(
        { sender },
        { ...INPUT, skillId: 'unknown', arguments: { text: 'apple', wordLanguage: 'en' } }
      )
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(runSkill).not.toHaveBeenCalled()
  })

  it('returns INVALID_INPUT for malformed send input without a raw parse exception', () => {
    const sendMessage = vi.fn()
    const module = { sendMessage } as unknown as ConversationModule
    registerConversationIpc(module, registerTrustedHandler)

    expect(
      registeredHandler(CONVERSATION_CHANNELS.send)(
        { sender: new FakeSender() },
        { ...INPUT, text: '' }
      )
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('rejects untrusted sources on every request channel before calling Core', () => {
    const module = {
      createConversation: vi.fn(),
      listConversations: vi.fn(),
      loadConversation: vi.fn(),
      sendMessage: vi.fn(),
      runSkill: vi.fn(),
      retryMessage: vi.fn(),
      cancelMessage: vi.fn()
    } as unknown as ConversationModule
    registerConversationIpc(module, registerTrustedHandler)

    const foreign = new FakeSender()
    foreign.owned = false
    const navigated = new FakeSender()
    navigated.mainFrame = { url: 'https://untrusted.invalid/' }
    const destroyed = new FakeSender()
    destroyed.destroyed = true

    for (const channel of [
      CONVERSATION_CHANNELS.create,
      CONVERSATION_CHANNELS.list,
      CONVERSATION_CHANNELS.load,
      CONVERSATION_CHANNELS.send,
      CONVERSATION_CHANNELS.runSkill,
      CONVERSATION_CHANNELS.retry,
      CONVERSATION_CHANNELS.cancel
    ]) {
      const handler = registeredHandler(channel)
      for (const event of [
        { sender: foreign },
        { sender: navigated },
        { sender: destroyed },
        { sender: new FakeSender(), senderFrame: null },
        { sender: new FakeSender(), senderFrame: { url: RENDERER_URL } }
      ]) {
        expect(handler(event, INPUT)).toEqual({
          status: 'error',
          error: { code: 'UNTRUSTED_SOURCE' }
        })
      }
    }
    expect(module.createConversation).not.toHaveBeenCalled()
    expect(module.listConversations).not.toHaveBeenCalled()
    expect(module.loadConversation).not.toHaveBeenCalled()
    expect(module.sendMessage).not.toHaveBeenCalled()
    expect(module.runSkill).not.toHaveBeenCalled()
    expect(module.retryMessage).not.toHaveBeenCalled()
    expect(module.cancelMessage).not.toHaveBeenCalled()
  })

  it('unregisters every request channel through the returned cleanup', () => {
    const module = {} as unknown as ConversationModule
    const cleanup = registerConversationIpc(module, registerTrustedHandler)

    expect(electronMocks.handle).toHaveBeenCalledTimes(7)
    cleanup()
    for (const channel of Object.values(CONVERSATION_CHANNELS).filter(
      (candidate) => candidate !== CONVERSATION_CHANNELS.event
    )) {
      expect(electronMocks.removeHandler).toHaveBeenCalledWith(channel)
    }
  })
})
