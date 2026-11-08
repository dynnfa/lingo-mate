import { expect, it, vi, type Mock } from 'vitest'
import { QqAdapter } from '../qq-adapter'
import type { QqSocketFactory, QqSocketHandlers } from '../qq-gateway'
import type { AdapterContext } from '../../../../core/communication/communication-adapter'
import {
  inboundEventSchema,
  type Receipt
} from '../../../../core/communication/communication-contract'

function fixture(): {
  adapter: QqAdapter
  send: Mock<(frame: string) => void>
  close: Mock
  http: Mock<typeof fetch>
  diagnostics: Mock
  context: {
    receive: Mock<AdapterContext['receive']>
    receiveRejected: Mock<AdapterContext['receiveRejected']>
    disconnected: Mock
    saveInitialCursor: Mock
    discardCursor: Mock
  }
  controller: AbortController
  frame(data: unknown): void
  ended(code?: number): void
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
  const diagnostics = vi.fn()
  const adapter = new QqAdapter('123456', 'fixture-secret', {
    fetch: http,
    open,
    onDiagnostic: diagnostics
  })
  const frame = (data: unknown): void => handlers.message(JSON.stringify(data))
  const ended = (code?: number): void => handlers.ended(code)
  const connect = async (cursor?: string): Promise<{ ready: Promise<void> }> => {
    const ready = adapter.start({ ...context, cursor })
    await vi.waitFor(() => expect(handlers).toBeDefined())
    frame({ op: 10, d: { heartbeat_interval: 45000 } })
    return { ready }
  }
  return { adapter, send, close, http, diagnostics, context, controller, frame, ended, connect }
}
const readyFrame = { op: 0, s: 1, t: 'READY', d: { session_id: 'session-a' } }
const message = (
  s: number,
  id = 'ROBOT1.0_fixture',
  t = 'C2C_MESSAGE_CREATE'
): { op: number; s: number; t: string; id: string; d: Record<string, unknown> } => ({
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

it('admits QQ IDs with platform punctuation and replies using the original message ID', async () => {
  const f = fixture()
  try {
    const { ready } = await f.connect()
    f.frame(readyFrame)
    await ready
    const messageId = 'ROBOT1.0_fixture-part.signature!'
    const dispatch = message(2, messageId)
    f.frame({
      ...dispatch,
      id: 'C2C_MESSAGE_CREATE:fixture',
      d: { ...dispatch.d, timestamp: new Date().toISOString() }
    })

    expect(f.context.receive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ externalMessageId: messageId }),
      JSON.stringify({ version: 1, appId: '123456', sessionId: 'session-a', seq: 2 })
    )
    expect(f.context.receiveRejected).not.toHaveBeenCalled()
    expect(f.context.disconnected).not.toHaveBeenCalled()
    const event = inboundEventSchema.parse(f.context.receive.mock.calls[0][0])
    const replyId = 'ROBOT1.0_reply.signature!'
    f.http.mockResolvedValueOnce(Response.json({ id: replyId }))
    expect(
      await f.adapter.send(
        {
          externalActorId: event.externalActorId,
          externalConversationId: event.externalConversationId
        },
        { text: 'answer', format: 'plain' },
        {
          deliveryId: 'delivery',
          partId: 'part',
          sequence: 1,
          reply: { externalMessageId: event.externalMessageId, expiresAt: event.replyExpiresAt! }
        },
        f.controller.signal
      )
    ).toEqual({ status: 'sent', externalMessageId: replyId })
    expect(f.http).toHaveBeenLastCalledWith(
      'https://api.bot.qq.com/v2/users/USER_1/messages',
      expect.objectContaining({
        body: JSON.stringify({ content: 'answer', msg_type: 0, msg_id: messageId, msg_seq: 1 })
      })
    )
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
    let rejectReceipt!: (result: Receipt) => void
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
    rejectReceipt({ status: 'failed', code: 'STORAGE_FAILED' })
    await failed
    expect(f.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'QQ_ADMISSION_FAILED',
        reason: 'receipt-failed',
        phase: 'resume',
        eventType: 'C2C_MESSAGE_CREATE',
        sequence: 11,
        durableSequence: 10,
        messageIdStatus: 'valid',
        receiptStatus: 'failed',
        receiptCode: 'STORAGE_FAILED'
      })
    )
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

it.each([
  { t: 'FRIEND_ADD', d: { openid: 'USER_1' } },
  { t: 'GROUP_ADD_ROBOT', id: null, d: { group_openid: 'GROUP_1' } },
  { t: 'C2C_MESSAGE_CREATE', id: '', d: { ...message(2).d, id: undefined } }
])('keeps receiving after a known $t event has no ID', async (event) => {
  const f = fixture()
  try {
    const { ready } = await f.connect()
    f.frame(readyFrame)
    await ready
    f.frame({ op: 0, s: 2, ...event })
    f.frame({ ...message(3), id: undefined })
    await vi.waitFor(() => expect(f.context.receive).toHaveBeenCalledOnce())
    expect(f.context.receiveRejected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ externalEventId: expect.any(String), kind: 'unsupported' }),
      JSON.stringify({ version: 1, appId: '123456', sessionId: 'session-a', seq: 2 })
    )
    expect(f.context.receive).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'text', externalMessageId: 'ROBOT1.0_fixture' }),
      JSON.stringify({ version: 1, appId: '123456', sessionId: 'session-a', seq: 3 })
    )
    expect(f.context.disconnected).not.toHaveBeenCalled()
  } finally {
    await f.adapter.stop()
  }
})

it('stops at an unknown dispatch without a safe identity and ignores queued callbacks after stop', async () => {
  const f = fixture()
  const { ready } = await f.connect()
  f.frame(readyFrame)
  await ready
  f.frame({ op: 0, s: 2, t: 'PRIVATE_UNKNOWN_EVENT', id: 'PRIVATE_INVALID_ID!' })
  f.frame(message(3))
  await vi.waitFor(() =>
    expect(f.context.disconnected).toHaveBeenCalledWith(true, 'QQ_ADMISSION_FAILED', undefined)
  )
  expect(f.context.receiveRejected).toHaveBeenCalledWith(undefined, expect.any(String))
  expect(f.diagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      code: 'QQ_ADMISSION_FAILED',
      reason: 'missing-event-identity',
      eventType: 'unknown',
      sequence: 2,
      durableSequence: 1,
      eventIdStatus: 'invalid',
      messageIdStatus: 'missing'
    })
  )
  expect(JSON.stringify(f.diagnostics.mock.calls)).not.toContain('PRIVATE')
  expect(f.context.receive).not.toHaveBeenCalled()
  await f.adapter.stop()
  f.frame(message(4))
  expect(f.context.receive).not.toHaveBeenCalled()
})

it('reports a dispatch without a sequence before scheduling a reconnect', async () => {
  const f = fixture()
  try {
    const { ready } = await f.connect()
    f.frame(readyFrame)
    await ready
    f.frame({ ...message(2), s: undefined })
    expect(f.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'QQ_ADMISSION_FAILED',
        reason: 'missing-sequence',
        eventType: 'C2C_MESSAGE_CREATE',
        durableSequence: 1
      })
    )
    expect(f.context.disconnected).toHaveBeenCalledWith(true, 'QQ_ADMISSION_FAILED', undefined)
    expect(f.context.receive).not.toHaveBeenCalled()
  } finally {
    await f.adapter.stop()
  }
})

it('reports the disconnect classification alongside the close cause', async () => {
  const f = fixture()
  try {
    const { ready } = await f.connect()
    f.frame(readyFrame)
    await ready
    f.ended(4008)
    await vi.waitFor(() =>
      expect(f.diagnostics).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'QQ_GATEWAY_DISCONNECTED',
          errorCode: 'QQ_RATE_LIMITED',
          reason: 'socket-closed',
          closeCode: 4008
        })
      )
    )
    expect(f.context.disconnected).toHaveBeenCalledWith(true, 'QQ_RATE_LIMITED', 60_000)
  } finally {
    await f.adapter.stop()
  }
})

it('captures both IDs when invalid QQ message IDs prevent a rejection receipt', async () => {
  const f = fixture()
  try {
    const { ready } = await f.connect()
    f.frame(readyFrame)
    await ready
    f.context.receiveRejected.mockResolvedValueOnce({ status: 'failed', code: 'INVALID_INPUT' })
    const dispatch = message(2, 'message:2')
    f.frame({
      ...dispatch,
      id: 42,
      d: { ...dispatch.d, content: '/bind PRIVATE_BINDING_CODE' }
    })
    await vi.waitFor(() =>
      expect(f.diagnostics).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'QQ_ADMISSION_FAILED',
          reason: 'missing-event-identity',
          validationField: 'id',
          eventIdStatus: 'invalid',
          messageIdStatus: 'invalid',
          eventIdValue: 42,
          messageIdValue: 'message:2'
        })
      )
    )
    expect(JSON.stringify(f.diagnostics.mock.calls)).not.toMatch(/PRIVATE|USER_1/)
    expect(f.context.receive).not.toHaveBeenCalled()
  } finally {
    await f.adapter.stop()
  }
})

it('captures the ID type without logging nested fields when a rejected QQ message has an object ID', async () => {
  const f = fixture()
  try {
    const { ready } = await f.connect()
    f.frame(readyFrame)
    await ready
    f.context.receiveRejected.mockResolvedValueOnce({
      status: 'rejected',
      code: 'UNSUPPORTED_INPUT'
    })
    const dispatch = message(2)
    f.frame({
      ...dispatch,
      id: 'C2C_MESSAGE_CREATE:fixture',
      d: { ...dispatch.d, id: { content: 'PRIVATE' } }
    })
    await vi.waitFor(() =>
      expect(f.diagnostics).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'QQ_GATEWAY_RECEIPT',
          validationField: 'id',
          eventIdStatus: 'valid',
          eventIdValue: 'C2C_MESSAGE_CREATE:fixture',
          messageIdValue: { type: 'object' }
        })
      )
    )
    expect(JSON.stringify(f.diagnostics.mock.calls)).not.toContain('PRIVATE')
    expect(f.context.disconnected).not.toHaveBeenCalled()
  } finally {
    await f.adapter.stop()
  }
})

it('reports replay progress and binding receipts using only classified metadata', async () => {
  const f = fixture()
  try {
    const cursor = JSON.stringify({
      version: 1,
      appId: '123456',
      sessionId: 'PRIVATE_SESSION',
      seq: 7
    })
    const { ready } = await f.connect(cursor)
    f.context.receive
      .mockResolvedValueOnce({ status: 'persisted', code: 'AWAITING_CONFIRMATION' })
      .mockResolvedValueOnce({ status: 'rejected', code: 'PRIVATE_UNRECOGNIZED_RECEIPT_CODE' })
    f.frame({
      ...message(8, 'PRIVATE_MESSAGE_ID'),
      id: 'PRIVATE_EVENT_ID',
      d: {
        ...message(8, 'PRIVATE_MESSAGE_ID').d,
        author: { user_openid: 'PRIVATE_OPENID' },
        content: '/bind PRIVATE_BINDING_CODE'
      }
    })
    f.frame(message(9))
    f.frame({ op: 0, s: 10, t: 'RESUMED' })
    await ready
    expect(f.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'QQ_GATEWAY_RESUME',
        reason: 'requested',
        durableSequence: 7
      })
    )
    expect(f.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'QQ_GATEWAY_RECEIPT',
        eventType: 'C2C_MESSAGE_CREATE',
        sequence: 8,
        receiptStatus: 'persisted',
        receiptCode: 'AWAITING_CONFIRMATION'
      })
    )
    expect(f.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'QQ_GATEWAY_RESUME',
        reason: 'completed',
        firstReplaySequence: 8,
        durableSequence: 9
      })
    )
    expect(JSON.stringify(f.diagnostics.mock.calls)).not.toMatch(
      /PRIVATE|123456|fixture-access|fixture-secret/
    )
  } finally {
    await f.adapter.stop()
  }
})

it('identifies the invalid text field and keeps a rejected receipt from causing a reconnect', async () => {
  const f = fixture()
  try {
    const { ready } = await f.connect()
    f.frame(readyFrame)
    await ready
    f.context.receiveRejected.mockResolvedValueOnce({
      status: 'rejected',
      code: 'UNSUPPORTED_INPUT'
    })
    const dispatch = message(2)
    f.frame({ ...dispatch, d: { ...dispatch.d, message_type: undefined } })
    await vi.waitFor(() =>
      expect(f.diagnostics).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'QQ_GATEWAY_RECEIPT',
          sequence: 2,
          validationField: 'message_type',
          messageIdStatus: 'valid',
          receiptStatus: 'rejected',
          receiptCode: 'UNSUPPORTED_INPUT'
        })
      )
    )
    expect(f.context.disconnected).not.toHaveBeenCalled()
  } finally {
    await f.adapter.stop()
  }
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
