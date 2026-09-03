// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type {
  ConversationEvent,
  ConversationSummary,
  CreateConversationResult,
  ListConversationsResult,
  LoadConversationResult,
  LingoMateApi,
  SendMessageInput
} from '../../shared/conversation'
import App from './App'

const SESSION_A = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
const SESSION_B = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'
const SESSION_C = '44316d8e-c6fb-4d09-bcb8-56936a14932d'

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
    cancel: string[]
  }
  emit(event: ConversationEvent): void
}

function installApiMock(setup: {
  list?:
    | ListConversationsResult
    | Promise<ListConversationsResult>
    | (() => ListConversationsResult | Promise<ListConversationsResult>)
  create?: CreateConversationResult | Promise<CreateConversationResult>
  load?: (sessionId: string) => LoadConversationResult | Promise<LoadConversationResult>
}): ApiMock {
  const listeners = new Set<(event: ConversationEvent) => void>()
  const mock: ApiMock = {
    calls: { create: 0, list: 0, load: [], send: [], cancel: [] },
    emit(event) {
      for (const listener of listeners) listener(event)
    }
  }

  const api = {
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
      async load(input: { sessionId: string }) {
        mock.calls.load.push(input.sessionId)
        return (
          setup.load?.(input.sessionId) ?? {
            status: 'error',
            error: { code: 'NOT_FOUND', message: 'x' }
          }
        )
      },
      async send(input: SendMessageInput) {
        mock.calls.send.push(input)
        return { requestId: input.requestId, accepted: true as const }
      },
      async cancel(input: { requestId: string }) {
        mock.calls.cancel.push(input.requestId)
      },
      onEvent(listener: (event: ConversationEvent) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }

  vi.stubGlobal('api', api as unknown as LingoMateApi)
  return mock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App conversation recovery', () => {
  it('opens the most recent conversation and renders its history', async () => {
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
                  id: '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708',
                  role: 'user',
                  content: 'Hello',
                  createdAt: '2026-09-02T09:59:00.000Z'
                },
                {
                  id: '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5',
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
                  id: '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5',
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

    await waitFor(() => {
      expect(mock.calls.send).toHaveLength(1)
    })
    expect(mock.calls.send[0].sessionId).toBe(SESSION_A)
    const activeRequestId = mock.calls.send[0].requestId

    // 生成进行中，切换到会话 B
    fireEvent.change(screen.getByLabelText('会话'), { target: { value: SESSION_B } })

    await waitFor(() => {
      expect(screen.getByText('Bonjour 的历史回复')).toBeInTheDocument()
    })
    expect(mock.calls.cancel).toEqual([activeRequestId])

    // 旧会话的流式事件不得写入新会话视图
    mock.emit({
      type: 'chunk',
      requestId: activeRequestId,
      sessionId: SESSION_A,
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
          id: '7b097553-e4fb-48c9-be81-e25cfa55358e',
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
          id: 'f72cde28-b0f8-41d6-8a17-a6f2ea68262f',
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
    await waitFor(() => expect(mock.calls.send).toHaveLength(1))
    const oldRequestId = mock.calls.send[0].requestId

    fireEvent.change(screen.getByLabelText('会话'), { target: { value: SESSION_B } })
    await waitFor(() => expect(screen.getByLabelText('会话')).toHaveValue(SESSION_B))
    fireEvent.change(screen.getByLabelText('会话'), { target: { value: SESSION_A } })
    await waitFor(() => expect(screen.getByLabelText('会话')).toHaveValue(SESSION_A))

    fireEvent.change(screen.getByLabelText('练习内容'), { target: { value: 'second' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(mock.calls.send).toHaveLength(2))
    const currentRequestId = mock.calls.send[1].requestId

    mock.emit({ type: 'started', requestId: currentRequestId, sessionId: SESSION_A })

    mock.emit({
      type: 'completed',
      requestId: oldRequestId,
      sessionId: SESSION_A,
      messageId: 'b6dcfbcf-8dde-4170-b26f-81105b2ef7fb'
    })
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()

    mock.emit({
      type: 'chunk',
      requestId: currentRequestId,
      sessionId: SESSION_A,
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
    await waitFor(() => expect(mock.calls.send).toHaveLength(1))

    mock.emit({
      type: 'completed',
      requestId: mock.calls.send[0].requestId,
      sessionId: SESSION_A,
      messageId: 'b6dcfbcf-8dde-4170-b26f-81105b2ef7fb'
    })

    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(document.querySelector('main')?.getAttribute('data-phase')).toBe('ready')
    expect(screen.getByLabelText('会话')).toHaveValue(SESSION_A)
  })
})
