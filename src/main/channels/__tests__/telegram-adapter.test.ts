import { describe, expect, it, vi } from 'vitest'
import { TelegramApiClient, TelegramApiError } from '../telegram-api'
import { splitForTelegram, TelegramChannelAdapter } from '../telegram-adapter'
import type {
  IgnoredChannelEvent,
  InboundChannelMessage
} from '../../../core/channels/channel-types'

// fetch 替身的统一类型：与 TelegramApiClient 的注入签名对齐。
const asFetch = (stub: unknown): typeof fetch => stub as typeof fetch
const asCall = (call: unknown[]): [string, RequestInit] => call as unknown as [string, RequestInit]

const BASE = 'https://api.telegram.test'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function textUpdate(
  updateId: number,
  messageId: number,
  text: string,
  overrides: Record<string, unknown> = {}
): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: 7000000001, first_name: 'Leon', username: 'leon' },
      chat: { id: 8000000001, type: 'private', first_name: 'Leon' },
      date: 1770000000,
      text,
      ...overrides
    }
  }
}

describe('TelegramApiClient', () => {
  it('times out even when the caller supplies a cancellation signal', async () => {
    const client = new TelegramApiClient('t', {
      baseUrl: BASE,
      timeoutMs: 10,
      fetchImpl: asFetch(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true
            })
          })
      )
    })
    await expect(client.getMe(new AbortController().signal)).rejects.toMatchObject({
      code: 'NETWORK'
    })
  })

  it('fetches bot identity via getMe', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, result: { id: 6000000001, username: 'lingo_bot' } })
    )
    const client = new TelegramApiClient('123:TOKEN', {
      baseUrl: BASE,
      fetchImpl: asFetch(fetchImpl)
    })
    await expect(client.getMe()).resolves.toEqual({ id: '6000000001', username: 'lingo_bot' })
    const [url, init] = asCall(fetchImpl.mock.calls[0])
    expect(url).toBe(`${BASE}/bot123:TOKEN/getMe`)
    expect(init.method).toBe('POST')
  })

  it('classifies unauthorized responses as UNAUTHORIZED', async () => {
    const client = new TelegramApiClient('bad', {
      baseUrl: BASE,
      fetchImpl: vi.fn(async () =>
        jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 401)
      )
    })
    await expect(client.getMe()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('distinguishes webhook conflicts from duplicate polling conflicts', async () => {
    const webhookClient = new TelegramApiClient('t', {
      baseUrl: BASE,
      fetchImpl: asFetch(
        vi.fn(async () =>
          jsonResponse(
            {
              ok: false,
              error_code: 409,
              description: "Conflict: can't use getUpdates while webhook is active"
            },
            409
          )
        )
      )
    })
    await expect(webhookClient.getUpdates(0, 0)).rejects.toMatchObject({ code: 'CONFLICT_WEBHOOK' })

    const duplicateClient = new TelegramApiClient('t', {
      baseUrl: BASE,
      fetchImpl: asFetch(
        vi.fn(async () =>
          jsonResponse(
            {
              ok: false,
              error_code: 409,
              description: 'Conflict: terminated by other getUpdates request'
            },
            409
          )
        )
      )
    })
    await expect(duplicateClient.getUpdates(0, 0)).rejects.toMatchObject({
      code: 'CONFLICT_POLLING'
    })
  })

  it('wraps network failures as NETWORK errors', async () => {
    const client = new TelegramApiClient('t', {
      baseUrl: BASE,
      fetchImpl: asFetch(
        vi.fn(async () => {
          throw new TypeError('fetch failed')
        })
      )
    })
    await expect(client.getMe()).rejects.toBeInstanceOf(TelegramApiError)
    await expect(client.getMe()).rejects.toMatchObject({ code: 'NETWORK' })
  })

  it('sends messages with the chat id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, result: { message_id: 5 } }))
    const client = new TelegramApiClient('123:TOKEN', {
      baseUrl: BASE,
      fetchImpl: asFetch(fetchImpl)
    })
    await client.sendMessage('8000000001', 'hello')
    const [url, init] = asCall(fetchImpl.mock.calls[0])
    expect(url).toBe(`${BASE}/bot123:TOKEN/sendMessage`)
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: '8000000001', text: 'hello' })
  })
})

describe('TelegramChannelAdapter normalization', () => {
  it('ignores malformed private messages while continuing to the next update', async () => {
    const received: InboundChannelMessage[] = []
    const ignored: number[] = []
    const { adapter } = adapterWithUpdates([], {
      onMessage: (message) => {
        received.push(message)
      },
      onIgnored: (event) => {
        ignored.push(event.eventId)
      }
    })
    await adapter.processBatch([
      { update_id: 20, message: { chat: null, text: 'bad' } },
      textUpdate(21, 210, 'valid')
    ] as never[])
    expect(ignored).toEqual([20])
    expect(received).toHaveLength(1)
  })

  function adapterWithUpdates(
    updates: unknown[],
    handlers: {
      onMessage?: (m: InboundChannelMessage) => void
      onIgnored?: (event: IgnoredChannelEvent) => void
    } = {}
  ): { adapter: TelegramChannelAdapter; fetchImpl: ReturnType<typeof vi.fn> } {
    let call = 0
    const fetchImpl = vi.fn(async (_url: unknown) => {
      if (String(_url).includes('getUpdates')) {
        call += 1
        const batch = call === 1 ? updates : []
        return jsonResponse({ ok: true, result: batch })
      }
      return jsonResponse({ ok: true, result: {} })
    })
    const api = new TelegramApiClient('123:TOKEN', { baseUrl: BASE, fetchImpl: asFetch(fetchImpl) })
    const adapter = new TelegramChannelAdapter(api, 'conn-1', '6000000001', {
      onMessage: handlers.onMessage ?? (() => {}),
      onIgnored: handlers.onIgnored ?? (() => {})
    })
    return { adapter, fetchImpl }
  }

  it('normalizes private text messages into unified inbound shape', async () => {
    const received: InboundChannelMessage[] = []
    const { adapter } = adapterWithUpdates([textUpdate(10, 100, 'hello')], {
      onMessage: (message) => received.push(message)
    })
    await adapter.processBatch([textUpdate(10, 100, 'hello')] as never[])
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      platform: 'telegram',
      connectionId: 'conn-1',
      botId: '6000000001',
      eventId: 10,
      messageId: 100,
      senderId: '7000000001',
      chatId: '8000000001',
      text: 'hello',
      senderName: 'Leon'
    })
    expect(received[0].sentAt).toBe(new Date(1770000000_000).toISOString())
  })

  it('ignores group chats, non-text payloads and edited messages without bodies', async () => {
    const ignored: number[] = []
    const { adapter } = adapterWithUpdates([], {
      onIgnored: (event) => ignored.push(event.eventId)
    })
    const group = {
      update_id: 11,
      message: {
        message_id: 101,
        from: { id: 7000000001, is_bot: false },
        chat: { id: -1001234, type: 'supergroup' },
        date: 1770000000,
        text: 'group hello'
      }
    }
    const photo = {
      update_id: 12,
      message: {
        message_id: 102,
        from: { id: 7000000001, is_bot: false },
        chat: { id: 8000000001, type: 'private' },
        date: 1770000000,
        photo: []
      }
    }
    const edited = {
      update_id: 13,
      edited_message: {
        message_id: 103,
        from: { id: 7000000001, is_bot: false },
        chat: { id: 8000000001, type: 'private' },
        date: 1770000000,
        edit_date: 1770000100,
        text: 'edited'
      }
    }
    await adapter.processBatch([group, photo, edited] as never[])
    expect(ignored).toEqual([11, 12, 13])
  })

  it('splits oversized outbound text at line boundaries within Telegram limits', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, result: { message_id: 1 } }))
    const api = new TelegramApiClient('t', { baseUrl: BASE, fetchImpl: asFetch(fetchImpl) })
    const adapter = new TelegramChannelAdapter(api, 'conn-1', '6000000001', {
      onMessage: () => {},
      onIgnored: () => {}
    })
    const text = `${'line of text\n'.repeat(500)}` // ~6500 chars
    await adapter.send(
      { platform: 'telegram', connectionId: 'conn-1', botId: '6000000001', chatId: '8000000001' },
      text
    )
    const calls = fetchImpl.mock.calls.map(asCall)
    expect(calls.length).toBeGreaterThan(1)
    for (const [, init] of calls) {
      expect((JSON.parse(String(init.body)) as { text: string }).text.length).toBeLessThanOrEqual(
        4096
      )
    }
    expect(
      calls.map(([, init]) => (JSON.parse(String(init.body)) as { text: string }).text).join('')
    ).toBe(text)
  })
})

describe('TelegramChannelAdapter polling', () => {
  it('does not revive an old poll loop after a stop and restart', async () => {
    const sleepers: Array<() => void> = []
    const api = {
      getWebhookInfo: async () => ({ url: null }),
      getUpdates: vi.fn(async () => [])
    } as unknown as TelegramApiClient
    const adapter = new TelegramChannelAdapter(
      api,
      'conn-1',
      '6000000001',
      { onMessage: () => {}, onIgnored: () => {} },
      {
        sleep: () =>
          new Promise<void>((resolve) => {
            sleepers.push(resolve)
          })
      }
    )
    await adapter.start(0)
    await vi.waitFor(() => expect(sleepers).toHaveLength(1))
    adapter.stop()
    await adapter.start(0)
    await vi.waitFor(() => expect(sleepers).toHaveLength(2))
    sleepers[0]()
    await new Promise((resolve) => setImmediate(resolve))
    expect(api.getUpdates).toHaveBeenCalledTimes(2)
    adapter.stop()
    sleepers[1]()
  })

  it('does not begin polling when stopped during the webhook check', async () => {
    let finishCheck!: (value: { url: string | null }) => void
    const api = {
      getWebhookInfo: () =>
        new Promise<{ url: string | null }>((resolve) => {
          finishCheck = resolve
        }),
      getUpdates: vi.fn(async () => [])
    } as unknown as TelegramApiClient
    const adapter = new TelegramChannelAdapter(api, 'conn-1', '6000000001', {
      onMessage: () => {},
      onIgnored: () => {}
    })
    const start = adapter.start(0)
    adapter.stop()
    finishCheck({ url: null })
    await start
    expect(adapter.isPolling()).toBe(false)
    expect(api.getUpdates).not.toHaveBeenCalled()
  })

  it('advances the committed cursor past the last processed update', async () => {
    const committed: number[] = []
    let call = 0
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).includes('getUpdates')) {
        call += 1
        return jsonResponse({
          ok: true,
          result: call === 1 ? [textUpdate(30, 300, 'one'), textUpdate(31, 301, 'two')] : []
        })
      }
      return jsonResponse({ ok: true, result: {} })
    })
    const api = new TelegramApiClient('t', { baseUrl: BASE, fetchImpl: asFetch(fetchImpl) })
    const adapter = new TelegramChannelAdapter(
      api,
      'conn-1',
      '6000000001',
      {
        onMessage: () => {},
        onIgnored: () => {},
        commitCursor: async (offset) => {
          committed.push(offset)
        }
      },
      { pollIntervalMs: 1 }
    )
    await adapter.pollOnce(30)
    expect(committed).toEqual([32])
  })

  it('reports webhook conflicts without deleting them and stops polling', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).includes('getWebhookInfo')) {
        return jsonResponse({ ok: true, result: { url: 'https://example.com/hook' } })
      }
      throw new Error('getUpdates must not be called')
    })
    const api = new TelegramApiClient('t', { baseUrl: BASE, fetchImpl: asFetch(fetchImpl) })
    const states: string[] = []
    const adapter = new TelegramChannelAdapter(api, 'conn-1', '6000000001', {
      onMessage: () => {},
      onIgnored: () => {},
      onStateChanged: (state, errorCode) => states.push(`${state}:${errorCode ?? ''}`)
    })
    await adapter.start(0)
    expect(states).toContain('error:WEBHOOK_CONFLICT')
    expect(adapter.isPolling()).toBe(false)
  })

  it('stops receiving after stop()', async () => {
    let pollCount = 0
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).includes('getUpdates')) {
        pollCount += 1
        return jsonResponse({ ok: true, result: [] })
      }
      return jsonResponse({ ok: true, result: {} })
    })
    const api = new TelegramApiClient('t', { baseUrl: BASE, fetchImpl: asFetch(fetchImpl) })
    const adapter = new TelegramChannelAdapter(
      api,
      'conn-1',
      '6000000001',
      { onMessage: () => {}, onIgnored: () => {} },
      { pollIntervalMs: 1 }
    )
    const polling = adapter.start(0)
    await vi.waitFor(() => expect(pollCount).toBeGreaterThan(2))
    adapter.stop()
    await polling
    const countAtStop = pollCount
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pollCount).toBe(countAtStop)
    expect(adapter.isPolling()).toBe(false)
  })
})

describe('Telegram splitting boundaries', () => {
  it('keeps a newline at index 4096 out of the first segment', () => {
    const text = 'a'.repeat(4096) + '\nb'
    const segments = splitForTelegram(text)
    expect(segments.every((segment) => segment.length <= 4096)).toBe(true)
    expect(segments.join('')).toBe(text)
  })
})

describe('Telegram startup recovery', () => {
  it('retries an offline startup and starts polling with the original cursor', async () => {
    const waits: Array<{ ms: number; resolve: () => void }> = []
    const api = {
      getWebhookInfo: vi
        .fn()
        .mockRejectedValueOnce(new TelegramApiError('NETWORK', 'offline'))
        .mockRejectedValueOnce(new TelegramApiError('NETWORK', 'offline'))
        .mockResolvedValue({ url: null }),
      getUpdates: vi.fn(async () => [])
    }
    const adapter = new TelegramChannelAdapter(
      api as unknown as TelegramApiClient,
      'conn',
      'bot',
      { onMessage: vi.fn(), onIgnored: vi.fn() },
      { sleep: (ms) => new Promise<void>((resolve) => waits.push({ ms, resolve })) }
    )
    await adapter.start(42)
    expect(waits[0]?.ms).toBe(1000)
    waits[0].resolve()
    await vi.waitFor(() => expect(waits[1]?.ms).toBe(2000))
    waits[1].resolve()
    await vi.waitFor(() => expect(adapter.isPolling()).toBe(true))
    expect(api.getUpdates).toHaveBeenCalledWith(42, 25, expect.any(AbortSignal))
    adapter.stop()
    waits.at(-1)?.resolve()
  })
})

describe('Telegram startup retry cancellation', () => {
  it('does not retry after stopping during startup backoff', async () => {
    let resume!: () => void
    const api = {
      getWebhookInfo: vi.fn().mockRejectedValue(new TelegramApiError('NETWORK', 'offline')),
      getUpdates: vi.fn()
    }
    const adapter = new TelegramChannelAdapter(
      api as unknown as TelegramApiClient,
      'conn',
      'bot',
      { onMessage: vi.fn(), onIgnored: vi.fn() },
      {
        sleep: () =>
          new Promise<void>((resolve) => {
            resume = resolve
          })
      }
    )
    await adapter.start(0)
    expect(adapter.isStarting()).toBe(true)
    adapter.stop()
    resume()
    await new Promise((resolve) => setImmediate(resolve))
    expect(api.getWebhookInfo).toHaveBeenCalledOnce()
    expect(api.getUpdates).not.toHaveBeenCalled()
    expect(adapter.isStarting()).toBe(false)
  })

  it('does not retry invalid credentials', async () => {
    const sleep = vi.fn(async () => {})
    const api = {
      getWebhookInfo: vi.fn().mockRejectedValue(new TelegramApiError('UNAUTHORIZED', 'invalid'))
    }
    const adapter = new TelegramChannelAdapter(
      api as unknown as TelegramApiClient,
      'conn',
      'bot',
      { onMessage: vi.fn(), onIgnored: vi.fn() },
      { sleep }
    )
    await adapter.start(0)
    expect(sleep).not.toHaveBeenCalled()
    expect(adapter.isStarting()).toBe(false)
  })
})
