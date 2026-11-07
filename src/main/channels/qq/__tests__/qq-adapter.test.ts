import { expect, it, vi, type Mock } from 'vitest'
import { QqAdapter } from '../qq-adapter'
import type { QqSocketFactory, QqSocketHandlers } from '../qq-gateway'
import type { AdapterContext } from '../../../../core/communication/communication-adapter'

function fixture(): {
  adapter: QqAdapter
  send: Mock<(frame: string) => void>
  close: Mock
  http: Mock<typeof fetch>
  context: {
    receive: Mock<AdapterContext['receive']>
    receiveRejected: Mock<AdapterContext['receiveRejected']>
    disconnected: Mock
    saveInitialCursor: Mock
    discardCursor: Mock
  }
  controller: AbortController
  frame(data: unknown): void
  connect(cursor?: string): Promise<{ ready: Promise<void> }>
} {
  const send = vi.fn<(frame: string) => void>()
  const close = vi.fn()
  let handlers!: QqSocketHandlers
  const open: QqSocketFactory = (_url, next) => {
    handlers = next
    return { send, close }
  }
  const http = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith('/gateway/bot')
      ? Response.json({ url: 'wss://api.bot.qq.com/websocket/' })
      : Response.json({ access_token: 'fixture-access', expires_in: '7200' })
  )
  const controller = new AbortController()
  const context = {
    signal: controller.signal,
    receive: vi.fn<AdapterContext['receive']>().mockResolvedValue({ status: 'persisted' }),
    receiveRejected: vi
      .fn<AdapterContext['receiveRejected']>()
      .mockResolvedValue({ status: 'rejected' }),
    disconnected: vi.fn(),
    saveInitialCursor: vi.fn(() => true),
    discardCursor: vi.fn(() => true)
  }
  const adapter = new QqAdapter('123456', 'fixture-secret', { fetch: http, open })
  const frame = (data: unknown): void => handlers.message(JSON.stringify(data))
  const connect = async (cursor?: string): Promise<{ ready: Promise<void> }> => {
    const ready = adapter.start({ ...context, cursor })
    await vi.waitFor(() => expect(handlers).toBeDefined())
    frame({ op: 10, d: { heartbeat_interval: 45000 } })
    return { ready }
  }
  return { adapter, send, close, http, context, controller, frame, connect }
}
const readyFrame = { op: 0, s: 1, t: 'READY', d: { session_id: 'session-a' } }
const message = (s: number, id = 'ROBOT1.0_fixture', t = 'C2C_MESSAGE_CREATE'): unknown => ({
  op: 0,
  s,
  t,
  id: 'event-' + s,
  d: {
    id,
    author: { user_openid: 'USER_1', bot: false },
    content: 'hello',
    timestamp: '2026-11-05T12:30:00+08:00',
    message_type: 0,
    message_scene: { ext: ['msg_idx=REFIDX_1==', 'auth_token=PRIVATE'] }
  }
})

it('identifies with only the group/C2C intent and admits C2C text without forwarding scene secrets', async () => {
  const f = fixture()
  try {
    const { ready } = await f.connect()
    expect(f.send).toHaveBeenCalledWith(
      JSON.stringify({
        op: 2,
        d: { token: 'QQBot fixture-access', intents: 1 << 25, shard: [0, 1] }
      })
    )
    f.frame(readyFrame)
    await ready
    f.frame(message(2))
    f.frame(message(3, 'group-message', 'GROUP_AT_MESSAGE_CREATE'))
    await vi.waitFor(() => expect(f.context.receiveRejected).toHaveBeenCalledTimes(1))
    expect(f.context.receive).toHaveBeenCalledWith(
      expect.objectContaining({
        externalActorId: 'USER_1',
        externalConversationId: 'USER_1',
        externalMessageId: 'ROBOT1.0_fixture',
        externalMessageIndex: 'REFIDX_1==',
        scope: 'private',
        text: 'hello'
      }),
      JSON.stringify({ version: 1, appId: '123456', sessionId: 'session-a', seq: 2 })
    )
    expect(JSON.stringify(f.context.receive.mock.calls)).not.toContain('PRIVATE')
  } finally {
    await f.adapter.stop()
  }
})

it('stops before admitting dispatches if the initial READY cursor cannot be saved', async () => {
  const f = fixture()
  try {
    f.context.saveInitialCursor.mockReturnValueOnce(false)
    const { ready } = await f.connect()
    f.frame(readyFrame)
    f.frame(message(2))
    await expect(ready).rejects.toMatchObject({ retryable: true, code: 'QQ_ADMISSION_FAILED' })
    expect(f.context.receive).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledOnce()
  } finally {
    await f.adapter.stop()
  }
})

it('resumes at the durable sequence, and a failed receipt prevents later queued dispatch', async () => {
  const f = fixture()
  try {
    let rejectReceipt!: (result: { status: 'failed' }) => void
    f.context.receive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          rejectReceipt = resolve
        })
    )
    const cursor = JSON.stringify({ version: 1, appId: '123456', sessionId: 'session-a', seq: 10 })
    const { ready } = await f.connect(cursor)
    const failed = expect(ready).rejects.toMatchObject({
      code: 'QQ_ADMISSION_FAILED',
      retryable: true
    })
    expect(f.send).toHaveBeenCalledWith(
      JSON.stringify({
        op: 6,
        d: { token: 'QQBot fixture-access', session_id: 'session-a', seq: 10 }
      })
    )
    f.frame(message(11))
    f.frame(message(12, 'second'))
    f.frame({ op: 0, s: 13, t: 'RESUMED' })
    await vi.waitFor(() => expect(f.context.receive).toHaveBeenCalledTimes(1))
    rejectReceipt({ status: 'failed' })
    await failed
    expect(f.context.receive).toHaveBeenCalledTimes(1)
    expect(f.close).toHaveBeenCalledOnce()
  } finally {
    await f.adapter.stop()
  }
})

it('sends one passive request per attempt and treats a duplicate sequence as uncertain', async () => {
  const f = fixture()
  try {
    const { ready } = await f.connect()
    f.frame(readyFrame)
    await ready
    const target = { externalActorId: 'USER_1', externalConversationId: 'USER_1' }
    const part = { text: 'answer', format: 'plain' as const }
    const identity = {
      deliveryId: 'delivery',
      partId: 'part',
      sequence: 2,
      reply: { externalMessageId: 'ROBOT1.0_fixture', expiresAt: Date.now() + 60_000 }
    }
    f.http.mockResolvedValueOnce(Response.json({ code: 40054005 }, { status: 400 }))
    expect(await f.adapter.send(target, part, identity, f.controller.signal)).toEqual({
      status: 'uncertain'
    })
    expect(f.http).toHaveBeenLastCalledWith(
      'https://api.bot.qq.com/v2/users/USER_1/messages',
      expect.objectContaining({
        body: JSON.stringify({
          content: 'answer',
          msg_type: 0,
          msg_id: 'ROBOT1.0_fixture',
          msg_seq: 2
        }),
        redirect: 'error'
      })
    )
    f.http.mockResolvedValueOnce(
      Response.json({}, { status: 429, headers: { 'retry-after': '3' } })
    )
    expect(await f.adapter.send(target, part, identity, f.controller.signal)).toEqual({
      status: 'retry',
      retryAfterMs: 3000
    })
    expect(
      await f.adapter.send(
        target,
        part,
        { ...identity, reply: { ...identity.reply, expiresAt: Date.now() } },
        f.controller.signal
      )
    ).toEqual({ status: 'failed', terminal: true })
    expect(f.http).toHaveBeenCalledTimes(4)
  } finally {
    await f.adapter.stop()
  }
})

it('drops a rejected Resume cursor and asks the service for a fresh connection', async () => {
  const f = fixture()
  const { ready } = await f.connect(
    JSON.stringify({ version: 1, appId: '123456', sessionId: 'old', seq: 7 })
  )
  f.frame({ op: 9, d: false })
  await expect(ready).rejects.toMatchObject({ retryable: true, retryAfterMs: 3000 })
  expect(f.context.discardCursor).toHaveBeenCalledOnce()
  expect(f.send).toHaveBeenCalledTimes(1)
})

it('uses the latest received sequence for heartbeats and stops when an ACK is missing', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    const { ready } = await f.connect()
    f.frame(readyFrame)
    await ready
    f.frame(message(2))
    f.frame({ op: 1 })
    expect(f.send).toHaveBeenLastCalledWith(JSON.stringify({ op: 1, d: 2 }))
    f.frame({ op: 11 })
    await vi.advanceTimersByTimeAsync(45000)
    expect(f.send).toHaveBeenCalledTimes(3)
    expect(f.context.disconnected).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(45000)
    expect(f.context.disconnected).toHaveBeenCalledWith(true, 'CONNECTION_LOST', undefined)
  } finally {
    await f.adapter.stop()
    vi.useRealTimers()
  }
})

it('stops at a dispatch without a safe identity and ignores queued callbacks after stop', async () => {
  const f = fixture()
  const { ready } = await f.connect()
  f.frame(readyFrame)
  await ready
  f.frame({ op: 0, s: 2, t: 'FRIEND_ADD', d: { openid: 'USER_1' } })
  f.frame(message(3))
  await vi.waitFor(() =>
    expect(f.context.disconnected).toHaveBeenCalledWith(true, 'QQ_ADMISSION_FAILED', undefined)
  )
  expect(f.context.receiveRejected).toHaveBeenCalledWith(undefined, expect.any(String))
  expect(f.context.receive).not.toHaveBeenCalled()
  await f.adapter.stop()
  f.frame(message(4))
  expect(f.context.receive).not.toHaveBeenCalled()
})

it('keeps long replies within four Unicode-safe parts and localizes the truncation notice', () => {
  const f = fixture()
  const text = 'a'.repeat(999) + '🪴'.repeat(2600)
  const parts = f.adapter.encode(text, 'zh-CN')
  expect(parts).toHaveLength(4)
  expect(
    parts.every((p) => p.format === 'plain' && p.text.length <= 1000 && p.text.isWellFormed())
  ).toBe(true)
  expect(parts[0].text).toBe('a'.repeat(999))
  expect(parts[3].text).toContain('完整答案可在桌面端查看')
})
