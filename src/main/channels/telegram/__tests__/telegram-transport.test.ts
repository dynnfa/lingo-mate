import { expect, it, vi } from 'vitest'
import { createTelegramTransport, TelegramTransportError } from '../telegram-transport'
const token = '123456:abcdefghijklmnopqrstuvwxyz123456789'
it('uses only the fixed HTTPS endpoint, no redirects, and no implicit retries', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { id: 1 } })))
  const transport = createTelegramTransport(token, fetcher)
  expect(await transport.call('getMe', {}, new AbortController().signal, 1000)).toEqual({ id: 1 })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledWith(
    `https://api.telegram.org/bot${token}/getMe`,
    expect.objectContaining({ redirect: 'error', method: 'POST' })
  )
  await expect(
    transport.call('evil' as 'getMe', {}, new AbortController().signal, 1000)
  ).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it.each([
  new Response('bad JSON'),
  new Response('a'.repeat(2 * 1024 * 1024 + 1)),
  new Response('gateway', { status: 502 })
])('bounds and classifies malformed responses without echoing secrets', async (response) => {
  const transport = createTelegramTransport(token, async () => response)
  const error = await transport
    .call('sendMessage', {}, new AbortController().signal, 1000)
    .catch((e) => e)
  expect(error).toBeInstanceOf(TelegramTransportError)
  expect((error as TelegramTransportError).started).toBe(true)
  expect(String(error)).not.toContain(token)
  expect((error as TelegramTransportError).cause).toBeUndefined()
})
it('preserves platform retry_after and treats thrown fetch errors as possibly sent', async () => {
  const transport = createTelegramTransport(
    token,
    async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 120 } }),
        { status: 429 }
      )
  )
  await expect(
    transport.call('sendMessage', {}, new AbortController().signal, 1000)
  ).rejects.toMatchObject({ code: 'TELEGRAM_RATE_LIMITED', retryAfterMs: 120000 })
  const broken = createTelegramTransport(token, async () => {
    throw new Error(`https://secret/${token}`)
  })
  await expect(
    broken.call('sendMessage', {}, new AbortController().signal, 1000)
  ).rejects.toMatchObject({ code: 'TELEGRAM_NETWORK', started: true })
})
it('does not send an already cancelled request', async () => {
  const fetcher = vi.fn()
  const controller = new AbortController()
  controller.abort()
  await expect(
    createTelegramTransport(token, fetcher).call('sendMessage', {}, controller.signal, 1000)
  ).rejects.toMatchObject({ started: false })
  expect(fetcher).not.toHaveBeenCalled()
})
it('enforces a request deadline across an active HTTP operation and sanitizes the rejection', async () => {
  vi.useFakeTimers()
  try {
    const fetcher: typeof fetch = vi.fn(
      async (_input, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error(`secret ${token}`)), {
            once: true
          })
        })
    )
    const result = createTelegramTransport(token, fetcher).call(
      'getUpdates',
      {},
      new AbortController().signal,
      25
    )
    const check = expect(result).rejects.toMatchObject({ code: 'TELEGRAM_NETWORK', started: true })
    await vi.advanceTimersByTimeAsync(25)
    await check
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
it('rejects malformed UTF-8 and unsafe retry information', async () => {
  for (const response of [
    new Response(new Uint8Array([0xff, 0xfe])),
    new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: -1 } }), {
      status: 429
    })
  ]) {
    await expect(
      createTelegramTransport(token, async () => response).call(
        'sendMessage',
        {},
        new AbortController().signal,
        1000
      )
    ).rejects.toMatchObject({ started: true })
  }
})
