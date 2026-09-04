// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type {
  CancelMessageResult,
  ConversationEvent,
  ConversationSummary,
  CreateConversationResult,
  GenerationStarted,
  ListConversationsResult,
  LoadConversationResult,
  LingoMateApi,
  RetryMessageInput,
  SendMessageInput
} from '../../shared/conversation'
import App from './App'

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

function summary(sessionId: string, updatedAt: string): ConversationSummary {
  return { sessionId, createdAt: '2026-09-01T08:00:00.000Z', updatedAt }
}

interface ApiMock {
  calls: {
    create: number
    list: number
    load: string[]
    send: SendMessageInput[]
    retry: RetryMessageInput[]
    cancel: string[]
  }
  generations: GenerationStarted[]
  emit(event: ConversationEvent): void
}

function installApiMock(setup: {
  list?:
    | ListConversationsResult
    | Promise<ListConversationsResult>
    | (() => ListConversationsResult | Promise<ListConversationsResult>)
  create?: CreateConversationResult | Promise<CreateConversationResult>
  load?: (sessionId: string) => LoadConversationResult | Promise<LoadConversationResult>
  send?: (
    generation: GenerationStarted
  ) => Promise<{ status: 'ok'; accepted: true; generation: GenerationStarted }>
  cancel?: (requestId: string) => CancelMessageResult | Promise<CancelMessageResult>
}): ApiMock {
  const listeners = new Set<(event: ConversationEvent) => void>()
  const generations: GenerationStarted[] = []
  const userContent = new Map<string, string>()
  const mock: ApiMock = {
    calls: { create: 0, list: 0, load: [], send: [], retry: [], cancel: [] },
    generations,
    emit(event) {
      for (const listener of listeners) listener(event)
    }
  }

  const api: LingoMateApi = {
    conversation: {
      async create() {
        mock.calls.create += 1
        return setup.create ?? { status: 'error', error: { code: 'UNKNOWN_ERROR', message: 'x' } }
      },
      async list() {
        mock.calls.list += 1
        if (typeof setup.list === 'function') return setup.list()
        if (setup.list) return setup.list
        throw new Error('list not configured')
      },
      async load(input) {
        mock.calls.load.push(input.sessionId)
        return (
          setup.load?.(input.sessionId) ?? {
            status: 'error',
            error: { code: 'NOT_FOUND', message: 'x' }
          }
        )
      },
      async send(input) {
        mock.calls.send.push(input)
        const generation: GenerationStarted = {
          requestId: input.requestId,
          sessionId: input.sessionId,
          userMessage: {
            messageId: crypto.randomUUID(),
            sessionId: input.sessionId,
            role: 'user',
            content: input.text,
            createdAt: NOW
          },
          assistantMessageId: crypto.randomUUID()
        }
        generations.push(generation)
        userContent.set(generation.userMessage.messageId, input.text)
        const fallback = { status: 'ok' as const, accepted: true as const, generation }
        return setup.send?.(generation) ?? fallback
      },
      async retry(input) {
        mock.calls.retry.push(input)
        const generation: GenerationStarted = {
          requestId: input.requestId,
          sessionId: input.sessionId,
          userMessage: {
            messageId: input.userMessageId,
            sessionId: input.sessionId,
            role: 'user',
            content: userContent.get(input.userMessageId) ?? '',
            createdAt: NOW
          },
          assistantMessageId: crypto.randomUUID()
        }
        generations.push(generation)
        return { status: 'ok', accepted: true, generation }
      },
      async cancel(input) {
        mock.calls.cancel.push(input.requestId)
        return setup.cancel?.(input.requestId) ?? { status: 'ok' }
      },
      onEvent(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }

  vi.stubGlobal('api', api)
  return mock
}

async function renderReady(mock: ApiMock): Promise<void> {
  render(<App />)
  await waitFor(() => {
    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
  })
  void mock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App conversation recovery', () => {
  it('opens the most recent conversation and renders its history with canonical ids', async () => {
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [
          summary(SESSION_A, '2026-09-02T10:00:00.000Z'),
          summary(SESSION_B, '2026-09-01T10:00:00.000Z')
        ]
      },
      load: (sessionId) =>
        sessionId === SESSION_A
          ? {
              status: 'ok',
              conversation: summary(SESSION_A, '2026-09-02T10:00:00.000Z'),
              messages: [
                {
                  messageId: '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708',
                  sessionId: SESSION_A,
                  role: 'user',
                  content: 'Hello',
                  createdAt: '2026-09-02T09:59:00.000Z'
                },
                {
                  messageId: '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5',
                  sessionId: SESSION_A,
                  role: 'assistant',
                  content: 'Hi there',
                  createdAt: '2026-09-02T10:00:00.000Z'
                }
              ]
            }
          : { status: 'error', error: { code: 'NOT_FOUND', message: 'x' } }
    })

    render(<App />)

    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    expect(mock.calls.load).toEqual([SESSION_A])
    expect(await screen.findByText('Hello')).toBeInTheDocument()
    expect(screen.getByText('Hi there')).toBeInTheDocument()
    expect(screen.getByLabelText('会话')).toHaveValue(SESSION_A)
    expect(document.querySelector('.message.assistant')?.getAttribute('data-message-id')).toBe(
      '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5'
    )
  })

  it('creates a conversation when the database is empty', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [] },
      create: {
        status: 'ok',
        conversation: summary(SESSION_A, '2026-09-03T10:00:00.000Z')
      },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, '2026-09-03T10:00:00.000Z'),
        messages: []
      })
    })

    render(<App />)

    expect(await screen.findByText('输入一句话，开始第一个本地对话切片。')).toBeInTheDocument()
    expect(mock.calls.create).toBe(1)
    expect(mock.calls.load).toEqual([SESSION_A])
    expect(screen.getByLabelText('练习内容')).toBeEnabled()
  })

  it('blocks sending while startup recovery has not finished', async () => {
    installApiMock({ list: new Promise(() => undefined) })

    render(<App />)

    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('loading')
    expect(screen.getByLabelText('练习内容')).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })

  it('shows a failed state and keeps the composer locked when recovery fails', async () => {
    installApiMock({
      list: {
        status: 'error',
        error: { code: 'PERSISTENCE_ERROR', message: '访问本地会话数据失败，请稍后重试。' }
      }
    })

    render(<App />)

    expect(await screen.findByText('访问本地会话数据失败，请稍后重试。')).toBeInTheDocument()
    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('failed')
    expect(screen.getByLabelText('练习内容')).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })

  it('handles a rejected recovery call without leaving the UI loading', async () => {
    installApiMock({ list: Promise.reject(new Error('ipc unavailable')) })

    render(<App />)

    expect(await screen.findByText('无法加载会话，请稍后重试。')).toBeInTheDocument()
    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('failed')
    expect(screen.getByLabelText('练习内容')).toBeDisabled()
  })
})

describe('App message lifecycle', () => {
  const loadedEmpty = (sessionId: string): LoadConversationResult => ({
    status: 'ok',
    conversation: summary(sessionId, '2026-09-02T10:00:00.000Z'),
    messages: []
  })

  async function submitMessage(text: string): Promise<void> {
    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
  }

  it('renders one assistant element under the canonical messageId from first paint to completion', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedEmpty(SESSION_A)
    })
    await renderReady(mock)

    await submitMessage('Hello')
    const generation = await waitFor(() => mock.generations[0])

    // send 结果到达后：user 与 assistant draft 首次出现即使用 canonical messageId
    await waitFor(() => {
      expect(
        document.querySelector(`[data-message-id="${generation.assistantMessageId}"]`)
      ).toBeInTheDocument()
    })
    expect(document.querySelectorAll('.message')).toHaveLength(2)

    mock.emit({ type: 'started', ...generation })
    mock.emit({
      type: 'chunk',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId,
      delta: 'Hi'
    })
    expect(await screen.findByText('Hi')).toBeInTheDocument()

    mock.emit({
      type: 'completed',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      message: {
        messageId: generation.assistantMessageId,
        sessionId: SESSION_A,
        role: 'assistant',
        content: 'Hi there',
        createdAt: NOW
      }
    })

    expect(await screen.findByText('Hi there')).toBeInTheDocument()
    // completed 原位对账：不产生第二条 assistant，key 仍是同一个 canonical id
    expect(document.querySelectorAll('.message.assistant')).toHaveLength(1)
    expect(document.querySelector('.message.assistant')?.getAttribute('data-message-id')).toBe(
      generation.assistantMessageId
    )
    expect(await screen.findByText('回复完成')).toBeInTheDocument()
    expect(screen.getByLabelText('练习内容')).toBeEnabled()
  })

  it('merges a started event that arrives before the send result without duplicating messages', async () => {
    const pendingSend = deferred<{
      status: 'ok'
      accepted: true
      generation: GenerationStarted
    }>()
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedEmpty(SESSION_A),
      send: (generation) => {
        void generation
        return pendingSend.promise
      }
    })
    await renderReady(mock)

    await submitMessage('Hello')
    await waitFor(() => expect(mock.calls.send).toHaveLength(1))

    // started 事件先于 send 结果到达
    mock.emit({ type: 'started', ...mock.generations[0] })
    await waitFor(() => {
      expect(document.querySelectorAll('.message')).toHaveLength(2)
    })

    pendingSend.resolve({ status: 'ok', accepted: true, generation: mock.generations[0] })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    })

    // 幂等归并：仍只有一条 user 和一条 assistant
    expect(document.querySelectorAll('.message')).toHaveLength(2)
  })

  it('removes the partial draft and offers retry when the generation is cancelled', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedEmpty(SESSION_A)
    })
    await renderReady(mock)

    await submitMessage('Hello')
    const generation = await waitFor(() => mock.generations[0])
    mock.emit({ type: 'started', ...generation })
    mock.emit({
      type: 'chunk',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId,
      delta: 'partial'
    })
    expect(await screen.findByText('partial')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(mock.calls.cancel).toEqual([generation.requestId])

    mock.emit({
      type: 'cancelled',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId
    })

    expect(await screen.findByText('已取消，可重试。')).toBeInTheDocument()
    // 部分草稿被删除，只保留 user，并标记可重试
    expect(document.querySelectorAll('.message')).toHaveLength(1)
    expect(screen.getByText('Hello')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(mock.calls.retry).toHaveLength(1))
    expect(mock.calls.retry[0]).toMatchObject({
      sessionId: SESSION_A,
      userMessageId: generation.userMessage.messageId
    })

    const retryGeneration = await waitFor(() => mock.generations[1])
    expect(retryGeneration.userMessage.messageId).toBe(generation.userMessage.messageId)
    expect(retryGeneration.assistantMessageId).not.toBe(generation.assistantMessageId)

    mock.emit({ type: 'started', ...retryGeneration })
    mock.emit({
      type: 'completed',
      requestId: retryGeneration.requestId,
      sessionId: SESSION_A,
      message: {
        messageId: retryGeneration.assistantMessageId,
        sessionId: SESSION_A,
        role: 'assistant',
        content: 'Retry reply',
        createdAt: NOW
      }
    })

    expect(await screen.findByText('Retry reply')).toBeInTheDocument()
    // 不重复 user；assistant 使用新的 canonical ID
    expect(document.querySelectorAll('.message.user')).toHaveLength(1)
    expect(document.querySelectorAll('.message.assistant')).toHaveLength(1)
    expect(document.querySelector('.message.assistant')?.getAttribute('data-message-id')).toBe(
      retryGeneration.assistantMessageId
    )
  })

  it('drops the draft and shows the safe error when the model fails after chunks', async () => {
    const mock = installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => loadedEmpty(SESSION_A)
    })
    await renderReady(mock)

    await submitMessage('Hello')
    const generation = await waitFor(() => mock.generations[0])
    mock.emit({ type: 'started', ...generation })
    mock.emit({
      type: 'chunk',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId,
      delta: 'partial'
    })
    expect(await screen.findByText('partial')).toBeInTheDocument()

    mock.emit({
      type: 'failed',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId,
      error: { code: 'MODEL_ERROR', message: '生成回复失败，请稍后重试。' }
    })

    expect(await screen.findByText('生成回复失败，请稍后重试。')).toBeInTheDocument()
    expect(document.querySelectorAll('.message')).toHaveLength(1)
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.getByLabelText('练习内容')).toBeEnabled()
  })

  it('marks the last unanswered user message retryable after loading history', async () => {
    installApiMock({
      list: { status: 'ok', conversations: [summary(SESSION_A, NOW)] },
      load: () => ({
        status: 'ok',
        conversation: summary(SESSION_A, NOW),
        messages: [
          {
            messageId: '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708',
            sessionId: SESSION_A,
            role: 'user',
            content: 'Unanswered',
            createdAt: NOW
          }
        ]
      })
    })

    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    expect(await screen.findByText('Unanswered')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})

describe('App conversation switching', () => {
  it('blocks session transitions until a pending send returns its canonical generation', async () => {
    const pendingSend = deferred<{
      status: 'ok'
      accepted: true
      generation: GenerationStarted
    }>()
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [summary(SESSION_A, NOW), summary(SESSION_B, NOW)]
      },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, NOW),
        messages: []
      }),
      send: () => pendingSend.promise
    })
    await renderReady(mock)

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(mock.calls.send).toHaveLength(1))

    expect(screen.getByLabelText('会话')).toBeDisabled()
    expect(screen.getByRole('button', { name: '新会话' })).toBeDisabled()

    pendingSend.resolve({ status: 'ok', accepted: true, generation: mock.generations[0] })
    await waitFor(() => expect(screen.getByLabelText('会话')).toBeEnabled())
  })

  it('keeps the current session and request tracking when transition cancellation fails', async () => {
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [summary(SESSION_A, NOW), summary(SESSION_B, NOW)]
      },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, NOW),
        messages: []
      }),
      cancel: () => ({
        status: 'error',
        error: { code: 'REQUEST_NOT_FOUND', message: '无法取消当前回复。' }
      })
    })
    await renderReady(mock)

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    const generation = await waitFor(() => mock.generations[0])
    await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('会话'), { target: { value: SESSION_B } })

    expect(await screen.findByText('无法取消当前回复。')).toBeInTheDocument()
    expect(screen.getByLabelText('会话')).toHaveValue(SESSION_A)
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    expect(mock.calls.cancel).toEqual([generation.requestId])
    expect(mock.calls.load).not.toContain(SESSION_B)
  })

  it('cancels the active request and ignores stale events when switching conversations', async () => {
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [
          summary(SESSION_A, '2026-09-02T10:00:00.000Z'),
          summary(SESSION_B, '2026-09-01T10:00:00.000Z')
        ]
      },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, '2026-09-01T10:00:00.000Z'),
        messages:
          sessionId === SESSION_B
            ? [
                {
                  messageId: '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5',
                  sessionId: SESSION_B,
                  role: 'assistant',
                  content: 'Bonjour 的历史回复',
                  createdAt: '2026-09-01T10:00:00.000Z'
                }
              ]
            : []
      })
    })

    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    const generation = await waitFor(() => mock.generations[0])
    expect(mock.calls.send[0].sessionId).toBe(SESSION_A)

    // 生成进行中，切换到会话 B
    fireEvent.change(screen.getByLabelText('会话'), { target: { value: SESSION_B } })

    await waitFor(() => {
      expect(screen.getByText('Bonjour 的历史回复')).toBeInTheDocument()
    })
    expect(mock.calls.cancel).toEqual([generation.requestId])

    // 旧会话的流式事件不得写入新会话视图
    mock.emit({
      type: 'chunk',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      messageId: generation.assistantMessageId,
      delta: 'stale'
    })
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument()
    expect(screen.getByText('Bonjour 的历史回复')).toBeInTheDocument()
  })

  it('locks interaction during a switch and only commits the latest load', async () => {
    const loadB = deferred<LoadConversationResult>()
    const loadC = deferred<LoadConversationResult>()
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [
          summary(SESSION_A, '2026-09-03T10:00:00.000Z'),
          summary(SESSION_B, '2026-09-02T10:00:00.000Z'),
          summary(SESSION_C, '2026-09-01T10:00:00.000Z')
        ]
      },
      load: (sessionId) => {
        if (sessionId === SESSION_B) return loadB.promise
        if (sessionId === SESSION_C) return loadC.promise
        return {
          status: 'ok',
          conversation: summary(SESSION_A, '2026-09-03T10:00:00.000Z'),
          messages: []
        }
      }
    })

    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    const selector = screen.getByLabelText('会话')
    fireEvent.change(selector, { target: { value: SESSION_B } })

    await waitFor(() => expect(mock.calls.load).toContain(SESSION_B))
    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('loading')
    expect(selector).toBeDisabled()
    expect(screen.getByLabelText('练习内容')).toBeDisabled()

    // 即使外部代码在加载期间触发第二次 change，旧加载也不能覆盖最后一次选择。
    Object.defineProperty(selector, 'disabled', { configurable: true, value: false })
    fireEvent.change(selector, { target: { value: SESSION_C } })
    await waitFor(() => expect(mock.calls.load).toContain(SESSION_C))

    loadC.resolve({
      status: 'ok',
      conversation: summary(SESSION_C, '2026-09-01T10:00:00.000Z'),
      messages: [
        {
          messageId: '7b097553-e4fb-48c9-be81-e25cfa55358e',
          sessionId: SESSION_C,
          role: 'assistant',
          content: '最新选择',
          createdAt: '2026-09-01T10:00:00.000Z'
        }
      ]
    })
    expect(await screen.findByText('最新选择')).toBeInTheDocument()

    loadB.resolve({
      status: 'ok',
      conversation: summary(SESSION_B, '2026-09-02T10:00:00.000Z'),
      messages: [
        {
          messageId: 'f72cde28-b0f8-41d6-8a17-a6f2ea68262f',
          sessionId: SESSION_B,
          role: 'assistant',
          content: '过期选择',
          createdAt: '2026-09-02T10:00:00.000Z'
        }
      ]
    })
    await Promise.resolve()

    expect(screen.getByLabelText('会话')).toHaveValue(SESSION_C)
    expect(screen.queryByText('过期选择')).not.toBeInTheDocument()
  })

  it('ignores terminal events from an invalidated request after returning to its session', async () => {
    const mock = installApiMock({
      list: {
        status: 'ok',
        conversations: [
          summary(SESSION_A, '2026-09-02T10:00:00.000Z'),
          summary(SESSION_B, '2026-09-01T10:00:00.000Z')
        ]
      },
      load: (sessionId) => ({
        status: 'ok',
        conversation: summary(sessionId, '2026-09-02T10:00:00.000Z'),
        messages: []
      })
    })

    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'first' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    const firstGeneration = await waitFor(() => mock.generations[0])

    fireEvent.change(screen.getByLabelText('会话'), { target: { value: SESSION_B } })
    await waitFor(() => expect(screen.getByLabelText('会话')).toHaveValue(SESSION_B))
    fireEvent.change(screen.getByLabelText('会话'), { target: { value: SESSION_A } })
    await waitFor(() => expect(screen.getByLabelText('会话')).toHaveValue(SESSION_A))

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'second' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    const secondGeneration = await waitFor(() => mock.generations[1])

    // 旧请求的终态不得影响当前生成
    mock.emit({
      type: 'completed',
      requestId: firstGeneration.requestId,
      sessionId: SESSION_A,
      message: {
        messageId: firstGeneration.assistantMessageId,
        sessionId: SESSION_A,
        role: 'assistant',
        content: 'stale reply',
        createdAt: NOW
      }
    })
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    expect(screen.queryByText('stale reply')).not.toBeInTheDocument()

    mock.emit({
      type: 'chunk',
      requestId: secondGeneration.requestId,
      sessionId: SESSION_A,
      messageId: secondGeneration.assistantMessageId,
      delta: 'current reply'
    })
    expect(await screen.findByText('current reply')).toBeInTheDocument()
  })

  it.each([
    {
      name: 'structured error',
      failure: () =>
        ({
          status: 'error',
          error: { code: 'PERSISTENCE_ERROR', message: '刷新会话列表失败。' }
        }) satisfies ListConversationsResult,
      expected: '刷新会话列表失败。'
    },
    {
      name: 'rejected call',
      failure: () => Promise.reject(new Error('ipc unavailable')),
      expected: '无法刷新会话列表，请稍后重试。'
    }
  ])('reports a $name while preserving the current conversation', async ({ failure, expected }) => {
    let listCall = 0
    const mock = installApiMock({
      list: () => {
        listCall += 1
        return listCall === 1
          ? {
              status: 'ok',
              conversations: [summary(SESSION_A, '2026-09-02T10:00:00.000Z')]
            }
          : failure()
      },
      load: () => ({
        status: 'ok',
        conversation: summary(SESSION_A, '2026-09-02T10:00:00.000Z'),
        messages: []
      })
    })

    render(<App />)
    await waitFor(() => {
      expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    })

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    const generation = await waitFor(() => mock.generations[0])

    mock.emit({
      type: 'completed',
      requestId: generation.requestId,
      sessionId: SESSION_A,
      message: {
        messageId: generation.assistantMessageId,
        sessionId: SESSION_A,
        role: 'assistant',
        content: 'Hi',
        createdAt: NOW
      }
    })

    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    expect(screen.getByLabelText('会话')).toHaveValue(SESSION_A)
  })
})
