import { expect, it, vi, type Mock } from 'vitest'
import type { SendResult } from '../../../../core/communication/communication-contract'
import type { AdapterContext } from '../../../../core/communication/communication-adapter'
import { TelegramAdapter } from '../telegram-adapter'
import { TelegramTransportError, type TelegramTransport } from '../telegram-transport'
import { makeCursor } from '../telegram-protocol'
function fixture(batches: unknown[][] = []): {
  calls: Array<{ method: string; parameters: Readonly<Record<string, unknown>> }>
  transport: TelegramTransport
  context: AdapterContext
  adapter: TelegramAdapter
  clock: { now(): number; advance(ms: number): void; sleep: Mock<(ms: number) => Promise<void>> }
} {
  const calls: Array<{ method: string; parameters: Readonly<Record<string, unknown>> }> = []
  const transport: TelegramTransport = {
    async call(method, parameters, signal) {
      calls.push({ method, parameters })
      if (method === 'getMe') return { id: 123456, is_bot: true, username: 'lingo_bot' }
      if (method === 'getWebhookInfo') return { url: '' }
      if (method === 'sendMessage') return { message_id: 9, chat: { id: 5, type: 'private' } }
      if (batches.length) return batches.shift()
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    }
  }
  const context: AdapterContext = {
    signal: new AbortController().signal,
    receive: vi.fn(async () => ({ status: 'persisted' as const })),
    receiveRejected: vi.fn(async () => ({ status: 'rejected' as const })),
    disconnected: vi.fn()
  }
  let time = 0
  const clock = {
    now: () => time,
    advance: (ms: number) => {
      time += ms
    },
    sleep: vi.fn(async (ms: number) => {
      time += ms
    })
  }
  return {
    calls,
    transport,
    context,
    adapter: new TelegramAdapter(transport, '123456', clock),
    clock
  }
}
const update = (id: number): unknown => ({
  update_id: id,
  message: {
    message_id: id,
    date: 1800000000,
    from: { id: 5, is_bot: false },
    chat: { id: 5, type: 'private' },
    text: 'hello'
  }
})
it('receives updates in order and only advances from durable receipts, stopping the batch on failed admission', async () => {
  const f = fixture([[update(2), { update_id: 1 }, update(3)]])
  vi.mocked(f.context.receive).mockResolvedValue({ status: 'failed', code: 'STORAGE_FAILED' })
  await f.adapter.start(f.context)
  await vi.waitFor(() => expect(f.context.disconnected).toHaveBeenCalled())
  expect(f.context.receiveRejected).toHaveBeenCalledWith(
    expect.objectContaining({ externalEventId: '1' }),
    makeCursor('123456', 2)
  )
  expect(f.context.receive).toHaveBeenCalledTimes(1)
  expect(f.calls.filter((c) => c.method === 'getUpdates')).toHaveLength(1)
  await f.adapter.stop()
})
it('resumes the durable cursor and stops a pending poll idempotently', async () => {
  const f = fixture()
  f.context.cursor = makeCursor('123456', 100)
  await f.adapter.start(f.context)
  expect(f.calls.find((c) => c.method === 'getUpdates')?.parameters).toMatchObject({
    offset: 100,
    allowed_updates: ['message'],
    timeout: 20,
    limit: 20
  })
  await f.adapter.stop()
  await f.adapter.stop()
  expect(f.context.disconnected).not.toHaveBeenCalled()
})
it('fails closed for webhook, bot mismatch and cursor mismatch', async () => {
  for (const kind of ['webhook', 'identity', 'cursor']) {
    const f = fixture()
    if (kind === 'cursor') f.context.cursor = makeCursor('999', 1)
    else {
      const original = f.transport.call
      f.transport.call = async (...args) =>
        args[0] === (kind === 'webhook' ? 'getWebhookInfo' : 'getMe')
          ? kind === 'webhook'
            ? { url: 'https://hook.invalid' }
            : { id: 999, is_bot: true, username: 'other_bot' }
          : original(...args)
    }
    await expect(f.adapter.start(f.context)).rejects.toThrow()
    expect(f.calls.some((c) => c.method === 'getUpdates')).toBe(false)
    await f.adapter.stop()
  }
})
it('sends only frozen private targets as plain text, throttles, and makes at most one call per send', async () => {
  const f = fixture()
  await f.adapter.start(f.context)
  const target = { externalActorId: '5', externalConversationId: '5' }
  const send = (): Promise<SendResult> =>
    f.adapter.send(
      target,
      { format: 'plain', text: '*hello*' },
      { deliveryId: 'd', partId: 'p' },
      f.context.signal
    )
  expect(await send()).toEqual({ status: 'sent', externalMessageId: '9' })
  expect(await send()).toMatchObject({ status: 'sent' })
  expect(f.clock.sleep).toHaveBeenCalledWith(1000, expect.any(AbortSignal))
  expect(f.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2)
  expect(f.calls.find((c) => c.method === 'sendMessage')?.parameters).toEqual({
    chat_id: '5',
    text: '*hello*',
    link_preview_options: { is_disabled: true }
  })
  expect(
    await f.adapter.send(
      { ...target, externalThreadId: '1' },
      { format: 'plain', text: 'bad' },
      { deliveryId: 'd', partId: 'q' },
      f.context.signal
    )
  ).toEqual({ status: 'failed' })
  await f.adapter.stop()
})
it.each([
  [new TelegramTransportError('TELEGRAM_RATE_LIMITED', true, 429, 120000), 'retry'],
  [new TelegramTransportError('TELEGRAM_UNAUTHORIZED', true, 401), 'failed'],
  [new TelegramTransportError('TELEGRAM_NETWORK', true), 'uncertain'],
  [new TelegramTransportError('TELEGRAM_NOT_SENT', false), 'retry'],
  [{ message_id: 1, chat: { id: 999, type: 'private' } }, 'uncertain']
])('classifies sends conservatively without implicit retries (%s)', async (response, status) => {
  const f = fixture()
  await f.adapter.start(f.context)
  const original = f.transport.call
  f.transport.call = vi.fn(async (...args: Parameters<TelegramTransport['call']>) => {
    if (args[0] !== 'sendMessage') return original(...args)
    if (response instanceof Error) throw response
    return response
  })
  const result = await f.adapter.send(
    { externalActorId: '5', externalConversationId: '5' },
    { format: 'plain', text: 'hello' },
    { deliveryId: 'd', partId: 'p' },
    f.context.signal
  )
  expect(result.status).toBe(status)
  if (response instanceof TelegramTransportError && response.retryAfterMs)
    expect(result).toMatchObject({ retryAfterMs: 120000 })
  expect(f.transport.call).toHaveBeenCalledTimes(1)
  await f.adapter.stop()
})
it('aborts the current poll after an authentication failure during send', async () => {
  const f = fixture()
  await f.adapter.start(f.context)
  const original = f.transport.call
  let pollSignal: AbortSignal | undefined
  f.transport.call = async (...args) => {
    if (args[0] === 'sendMessage')
      throw new TelegramTransportError('TELEGRAM_UNAUTHORIZED', true, 401)
    pollSignal = args[2]
    return original(...args)
  }
  // Observe the active poll signal via an initial empty poll.
  await f.adapter.stop()
  await f.adapter.start(f.context)
  await f.adapter.send(
    { externalActorId: '5', externalConversationId: '5' },
    { text: 'hello', format: 'plain' },
    { deliveryId: 'd', partId: 'p' },
    f.context.signal
  )
  expect(f.context.disconnected).toHaveBeenCalledWith(false, 'TELEGRAM_UNAUTHORIZED')
  expect(pollSignal?.aborted).toBe(true)
  await f.adapter.stop()
})
it('shares a 429 cooldown across queued deliveries and chats until the full wait expires', async () => {
  const f = fixture()
  await f.adapter.start(f.context)
  const original = f.transport.call
  const sentAt: number[] = []
  f.transport.call = async (...args) => {
    if (args[0] !== 'sendMessage') return original(...args)
    sentAt.push(f.clock.now())
    if (sentAt.length === 1) {
      f.clock.advance(500)
      throw new TelegramTransportError('TELEGRAM_RATE_LIMITED', true, 429, 120000)
    }
    return { message_id: 9, chat: { id: Number(args[1].chat_id), type: 'private' } }
  }
  const send = (actor: string, deliveryId: string): Promise<SendResult> =>
    f.adapter.send(
      { externalActorId: actor, externalConversationId: actor },
      { format: 'plain', text: deliveryId },
      { deliveryId, partId: deliveryId },
      f.context.signal
    )
  try {
    expect(await Promise.all([send('5', 'first'), send('5', 'same'), send('6', 'other')])).toEqual([
      { status: 'retry', retryAfterMs: 120000 },
      { status: 'retry', retryAfterMs: 120000 },
      { status: 'retry', retryAfterMs: 120000 }
    ])
    expect(sentAt).toEqual([0])
    f.clock.advance(119000)
    expect(await send('6', 'after-cooldown')).toEqual({ status: 'sent', externalMessageId: '9' })
    expect(sentAt).toEqual([0, 120500])
    expect(f.clock.sleep).toHaveBeenCalledWith(1000, expect.any(AbortSignal))
  } finally {
    await f.adapter.stop()
  }
})
it('preserves platform retry_after for the public reconnect scheduler', async () => {
  const f = fixture()
  const original = f.transport.call
  f.transport.call = async (...args) => {
    if (args[0] === 'getUpdates')
      throw new TelegramTransportError('TELEGRAM_RATE_LIMITED', true, 429, 120000)
    return original(...args)
  }
  await f.adapter.start(f.context)
  await vi.waitFor(() =>
    expect(f.context.disconnected).toHaveBeenCalledWith(true, 'TELEGRAM_RATE_LIMITED', 120000)
  )
  await f.adapter.stop()
})
