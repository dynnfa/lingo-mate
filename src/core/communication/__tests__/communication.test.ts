import type { InboundEvent, Receipt } from '../communication-contract'
import type { Binding } from '../communication-repository'
import { randomUUID, createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../database/database'
import { SqliteCommunicationRepository } from '../../../database/sqlite-communication-repository'
import { CommunicationService } from '../communication-service'
import { TestAdapter } from './test-adapter'
import type { BusinessPort } from '../business-port'

const disposers: Array<() => void> = []
afterEach(() => disposers.splice(0).forEach((close) => close()))
type TextEvent = Extract<InboundEvent, { type: 'text' }>
interface Fixture {
  service: CommunicationService
  repository: SqliteCommunicationRepository
  business: BusinessPort
  adapter: TestAdapter
  connectionId: string
  event(text?: string, actorId?: string, eventId?: string): TextEvent
  receive(text?: string, actor?: string, eventId?: string): Promise<Receipt>
  bind(actor?: string): Promise<Binding>
  start(): Promise<void>
  advance(ms: number): void
  db: ReturnType<typeof openDatabase>
}
function fixture(interactive = false): Fixture {
  const db = openDatabase(':memory:')
  disposers.push(() => db.close())
  let now = 1_800_000_000_000
  const repository = new SqliteCommunicationRepository(db)
  const adapter = new TestAdapter(interactive)
  const business: BusinessPort = {
    createSession: vi.fn(async (id) => {
      const at = new Date(now).toISOString()
      db.prepare('INSERT OR IGNORE INTO conversations VALUES (?, ?, ?, ?)').run(id, at, at, 'Test')
    }),
    execute: vi.fn(async () => ({ status: 'succeeded' as const, text: 'Safe answer' })),
    recover: vi.fn(async () => undefined),
    cancel: vi.fn()
  }
  const service = new CommunicationService(repository, business, {
    now: () => now,
    id: randomUUID,
    secret: () => 'AABBCCDDEEFF00112233445566778899AA',
    digest: (value) => createHash('sha256').update(value).digest('hex'),
    languages: () => ({ uiLanguage: 'en', outputLanguage: 'zh-CN', targetLanguage: 'en' }),
    diagnostics: vi.fn()
  })
  service.registerAdapter('test', () => adapter)
  const connectionId = service.addConnection('test')
  const event = (text = 'hello', actorId = 'alice', eventId: string = randomUUID()): TextEvent => ({
    type: 'text',
    externalEventId: eventId,
    externalMessageId: eventId,
    externalActorId: actorId,
    externalConversationId: actorId,
    scope: 'private',
    occurredAt: now,
    text
  })
  const start = (): Promise<void> => service.start(connectionId)
  const receive = (text = 'hello', actor = 'alice', eventId?: string): Promise<Receipt> =>
    adapter.receive(event(text, actor, eventId))
  const bind = async (actor = 'alice'): Promise<Binding> => {
    const challenge = service.createChallenge(connectionId, ['chat', 'sentence'])
    await receive(`/bind ${challenge.code}`, actor)
    return service.confirmBinding(challenge.challengeId)
  }
  return {
    service,
    repository,
    business,
    adapter,
    connectionId,
    event,
    receive,
    bind,
    start,
    advance: (ms: number) => {
      now += ms
    },
    db
  }
}

describe.each([false, true])('shared adapter contract (interactive=%s)', (interactive) => {
  it('requires local confirmation and isolates actors, connections and capabilities', async () => {
    const f = fixture(interactive)
    await f.start()
    expect((await f.receive()).code).toBe('UNBOUND')
    const binding = await f.bind()
    expect((await f.receive('hello', 'mallory')).code).toBe('UNBOUND')
    expect((await f.receive('/vocabulary secret')).code).toBe('CAPABILITY_DENIED')
    expect(binding.externalActorId).toBe('alice')
    expect(f.business.execute).not.toHaveBeenCalled()
    expect(() => f.service.addConnection('unknown')).toThrow('UNKNOWN_ADAPTER')
  })
  it('persists before acknowledging and executes a duplicate only once', async () => {
    const f = fixture(interactive)
    await f.start()
    await f.bind()
    const id = randomUUID()
    const first = await f.receive('hello', 'alice', id)
    expect(first.status).toBe('persisted')
    expect(await f.receive('hello', 'alice', id)).toEqual(first)
    expect((await f.receive('different', 'alice', id)).code).toBe('EVENT_CONFLICT')
    await f.service.flush()
    expect(f.business.execute).toHaveBeenCalledTimes(1)
    expect(f.adapter.sent.map((p) => p.text).join('')).toContain('Safe answer')
    await f.service.stop(f.connectionId)
    expect((await f.receive()).status).toBe('failed')
  })
  it('cancels without waiting behind the active business and checks ownership', async () => {
    const f = fixture(interactive)
    await f.start()
    const binding = await f.bind()
    let finish!: (value: { status: 'cancelled' }) => void
    vi.mocked(f.business.execute).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await f.receive()
    const flushing = f.service.flush()
    await vi.waitFor(() => expect(f.business.execute).toHaveBeenCalledTimes(1))
    expect((await f.receive('/cancel', 'mallory')).code).toBe('UNBOUND')
    await f.receive('/cancel')
    expect(f.business.cancel).toHaveBeenCalledTimes(1)
    finish({ status: 'cancelled' })
    await flushing
    f.service.revokeBinding(binding.id)
    expect((await f.receive()).code).toBe('UNBOUND')
  })
})

it('expires challenges, enforces attempts and consumes local confirmation once', async () => {
  const f = fixture()
  await f.start()
  const c = f.service.createChallenge(f.connectionId, ['chat'])
  for (let i = 0; i < 5; i++)
    expect((await f.receive('/bind wrong')).code).toBe('CHALLENGE_INVALID')
  expect((await f.receive(`/bind ${c.code}`)).code).toBe('CHALLENGE_INVALID')
  const expired = f.service.createChallenge(f.connectionId, ['chat'])
  f.advance(300_000)
  expect((await f.receive(`/bind ${expired.code}`)).code).toBe('CHALLENGE_INVALID')
  const b = await f.bind()
  const challenge = f.repository.read((s) =>
    [...s.challenges.values()].find((c) => c.actor === b.externalActorId)!
  )
  expect(() => f.service.confirmBinding(challenge.id)).toThrow('CHALLENGE_INVALID')
})
it('freezes language context, persists sessions and isolates connections and /new', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  await f.receive()
  await f.service.flush()
  const first = vi.mocked(f.business.execute).mock.calls[0][0]
  await f.receive('again')
  await f.service.flush()
  expect(vi.mocked(f.business.execute).mock.calls[1][0].sessionId).toBe(first.sessionId)
  await f.receive('/new')
  await f.service.flush()
  await f.receive('third')
  await f.service.flush()
  expect(vi.mocked(f.business.execute).mock.calls[2][0].sessionId).not.toBe(first.sessionId)
  expect(f.repository.read((s) => s.sessions.size)).toBe(2)
  expect(first.languages).toEqual({
    uiLanguage: 'en',
    outputLanguage: 'zh-CN',
    targetLanguage: 'en'
  })
  expect(f.db.pragma('foreign_key_check')).toEqual([])
})
it('keeps confirmation tickets scoped to binding, session, operation and original event', async () => {
  const f = fixture(true)
  await f.start()
  const b = await f.bind()
  await f.receive()
  await f.service.flush()
  const sessionRef = f.repository.read((s) => [...s.sessions.keys()][0])
  const input = {
    bindingId: b.id,
    sessionRef,
    eventId: 'original',
    operation: 'save',
    parameterDigest: 'digest'
  }
  const token = f.service.identity.issueConfirmation(input)
  expect(() =>
    f.service.identity.consumeConfirmation(token, { ...input, sessionRef: randomUUID() })
  ).toThrow('CONFIRMATION_INVALID')
  f.service.identity.consumeConfirmation(token, input)
  expect(() => f.service.identity.consumeConfirmation(token, input)).toThrow('CONFIRMATION_INVALID')
  const second = f.service.identity.issueConfirmation(input)
  f.service.revokeBinding(b.id)
  expect(() => f.service.identity.consumeConfirmation(second, input)).toThrow(
    'CONFIRMATION_INVALID'
  )
})
it('bounds queues and independently admits priority controls', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  for (let i = 0; i < 8; i++) expect((await f.receive(`message ${i}`)).status).toBe('persisted')
  expect((await f.receive('overflow')).code).toBe('QUEUE_FULL')
  expect((await f.receive('/cancel')).status).toBe('persisted')
  await f.service.flush()
  expect(f.business.execute).not.toHaveBeenCalled()
})
it('does not acknowledge or advance cursors when persistence fails', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  const event = f.event()
  const tx = vi.spyOn(f.repository, 'transaction').mockImplementationOnce(() => {
    throw new Error('disk full')
  })
  expect((await f.adapter.receive(event, 'opaque-cursor')).status).toBe('failed')
  tx.mockRestore()
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.cursor)).toBeUndefined()
  expect((await f.adapter.receive(event, 'opaque-cursor')).status).toBe('persisted')
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.cursor)).toBe('opaque-cursor')
  await f.service.flush()
  expect(f.business.execute).toHaveBeenCalledTimes(1)
})
it('retries saved unsent parts, preserves sent fragments and never reruns business', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  vi.mocked(f.business.execute).mockResolvedValue({ status: 'succeeded', text: 'a'.repeat(70) })
  f.adapter.outcomes = [
    { status: 'sent', externalMessageId: 'first' },
    { status: 'retry', retryAfterMs: 2000 }
  ]
  await f.receive()
  await f.service.flush()
  expect(f.adapter.sent).toHaveLength(1)
  await f.service.flush()
  expect(f.adapter.sent).toHaveLength(1)
  f.advance(2000)
  await f.service.flush()
  expect(f.adapter.sent).toHaveLength(3)
  expect(f.business.execute).toHaveBeenCalledTimes(1)
  expect(f.repository.read((s) => [...s.outbox.values()][0].state)).toBe('sent')
})
it('requires explicit duplicate acknowledgement for uncertain delivery', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  f.adapter.outcomes = [{ status: 'uncertain' }]
  await f.receive()
  await f.service.flush()
  const delivery = f.repository.read((s) => [...s.outbox.values()][0])
  expect(delivery.state).toBe('uncertain')
  await f.service.flush()
  expect(f.adapter.sent).toHaveLength(0)
  expect(() => f.service.resolveDelivery(delivery.id, 'retry')).toThrow('DUPLICATE_ACK_REQUIRED')
  f.service.resolveDelivery(delivery.id, 'retry', true)
  await f.service.flush()
  expect(f.adapter.sent).toHaveLength(1)
  expect(f.business.execute).toHaveBeenCalledTimes(1)
})
it('marks in-flight delivery uncertain on recovery and suppresses revoked targets', async () => {
  const f = fixture()
  await f.start()
  const binding = await f.bind()
  await f.receive()
  await f.service.flush()
  f.repository.transaction((s) => {
    const d = [...s.outbox.values()][0]
    d.state = 'sending'
    d.parts[0].state = 'sending'
  })
  await f.service.recover()
  expect(f.repository.read((s) => [...s.outbox.values()][0].state)).toBe('uncertain')
  f.service.revokeBinding(binding.id)
  expect(f.repository.read((s) => [...s.outbox.values()][0].state)).toBe('suppressed')
  expect(() =>
    f.service.resolveDelivery(
      f.repository.read((s) => [...s.outbox.keys()][0]),
      'retry',
      true
    )
  ).toThrow('DELIVERY_NOT_RETRYABLE')
})
it('never automatically replays dispatching/running work and only recovers proven results', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  await f.receive()
  await f.service.flush()
  f.repository.transaction((s) => {
    const i = [...s.inbox.values()].find((i) => i.request)!
    i.state = 'running'
    s.outbox.clear()
  })
  vi.mocked(f.business.recover).mockResolvedValue({
    status: 'succeeded',
    text: 'Proven saved result'
  })
  await f.service.recover()
  await f.start()
  await f.service.flush()
  expect(f.business.execute).toHaveBeenCalledTimes(1)
  expect(f.business.recover).toHaveBeenCalledTimes(1)
  expect(f.adapter.sent.at(-1)!.text).toBe('Proven saved result')
})
it('retains interrupted state for unknown results instead of replaying or guessing', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  await f.receive()
  f.repository.transaction((s) => {
    ;[...s.inbox.values()].find((i) => i.state === 'queued')!.state = 'dispatching'
  })
  await f.service.recover()
  await f.start()
  await f.service.flush()
  expect(f.business.execute).not.toHaveBeenCalled()
  expect(
    f.repository.read((s) => [...s.inbox.values()].some((i) => i.state === 'interrupted'))
  ).toBe(true)
})
it('prevents old callbacks and late delivery after stop, revoke and shutdown', async () => {
  const f = fixture()
  await f.start()
  const b = await f.bind()
  const old = f.adapter.context!
  await f.service.stop(f.connectionId)
  await f.start()
  expect((await old.receive(f.event())).code).toBe('STOPPED')
  await f.receive()
  f.service.revokeBinding(b.id)
  await f.service.flush()
  expect(f.business.execute).not.toHaveBeenCalled()
  await f.service.shutdown()
  expect((await f.receive()).code).toBe('STOPPED')
})
it('cleans body before tombstones and rejects old events after tombstone removal', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  const event = f.event()
  await f.adapter.receive(event)
  await f.service.flush()
  f.advance(8 * 86400_000)
  f.service.cleanup()
  const inbox = f.repository.read((s) =>
    [...s.inbox.values()].find((i) => i.eventId === event.externalEventId)!
  )
  expect(inbox.event).toBeUndefined()
  expect((await f.adapter.receive(event)).status).toBe('persisted')
  await f.service.flush()
  expect(f.business.execute).toHaveBeenCalledTimes(1)
  f.advance(23 * 86400_000)
  f.service.cleanup()
  expect((await f.adapter.receive(event)).code).toBe('EXPIRED')
  await f.service.flush()
  expect(f.business.execute).toHaveBeenCalledTimes(1)
})
it('rejects unsupported scope and input before all business side effects', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  expect((await f.adapter.receive({ ...f.event(), scope: 'group' })).code).toBe('UNSUPPORTED_SCOPE')
  expect((await f.adapter.receive({ ...f.event(), rawPayload: {} })).code).toBe('INVALID_INPUT')
  expect((await f.adapter.receive({ ...f.event(), text: 'a'.repeat(4001) })).code).toBe(
    'INVALID_INPUT'
  )
  expect(f.business.createSession).not.toHaveBeenCalled()
  expect(f.business.execute).not.toHaveBeenCalled()
})
it('does not convert committed results to business failure when completion persistence fails', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  await f.receive()
  const original = f.repository.transaction.bind(f.repository)
  let injected = false
  vi.spyOn(f.repository, 'transaction').mockImplementation((operation) =>
    original((state) => {
      const value = operation(state)
      if (!injected && [...state.inbox.values()].some((i) => i.state === 'succeeded')) {
        injected = true
        throw new Error('completion disk failure')
      }
      return value
    })
  )
  await f.service.flush()
  expect(f.repository.read((s) => [...s.inbox.values()].find((i) => i.request)!.state)).toBe(
    'interrupted'
  )
  expect(f.business.execute).toHaveBeenCalledTimes(1)
})
it('cancels during durable session creation without later business execution', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  const create = vi.mocked(f.business.createSession).getMockImplementation()!
  let proceed!: () => void
  vi.mocked(f.business.createSession).mockImplementation(async (...args) => {
    await new Promise<void>((resolve) => {
      proceed = resolve
    })
    await create(...args)
  })
  await f.receive()
  const flushing = f.service.flush()
  await vi.waitFor(() => expect(proceed).toBeDefined())
  await f.receive('/cancel')
  proceed()
  await flushing
  expect(f.business.execute).not.toHaveBeenCalled()
  expect(
    f.repository.read((s) =>
      [...s.inbox.values()].filter((i) => !i.control && i.receipt.requestId).map((i) => i.state)
    )
  ).toEqual(['cancelled'])
})
it('isolates the same actor across connections and rejects cross-account request cancellation', async () => {
  const f = fixture()
  await f.start()
  const b = await f.bind()
  const other = new TestAdapter(false)
  f.service.registerAdapter('another', () => other)
  const connection = f.service.addConnection('another')
  await f.service.start(connection)
  const c = f.service.createChallenge(connection, ['chat'])
  expect((await f.receive(`/bind ${c.code}`)).code).toBe('CHALLENGE_INVALID')
  const bindEvent = f.event(`/bind ${c.code}`)
  expect((await other.receive(bindEvent)).status).toBe('persisted')
  const binding = f.service.confirmBinding(c.challengeId)
  const original = await f.receive()
  expect(() => f.service.cancelRequest(binding.id, original.requestId!)).toThrow('OWNER_MISMATCH')
  expect(() => f.service.cancelRequest(b.id, original.requestId!)).not.toThrow()
  await other.receive(f.event('isolated'))
  await f.service.flush()
  expect(f.business.execute).toHaveBeenCalledTimes(1)
})
it('expires queued messages and limits accounts without blocking cancel', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  await f.receive()
  f.advance(300_000)
  await f.service.flush()
  expect(f.business.execute).not.toHaveBeenCalled()
  for (let i = 0; i < 20; i++) await f.receive('limited')
  expect((await f.receive('one more')).code).toBe('RATE_LIMITED')
  expect((await f.receive('/cancel')).status).toBe('persisted')
})
it('ends idle sessions and freezes the original route across rebind and deletion', async () => {
  const f = fixture()
  await f.start()
  const b = await f.bind()
  await f.receive()
  await f.service.flush()
  const first = vi.mocked(f.business.execute).mock.calls[0][0].sessionId
  f.advance(86400_000)
  await f.receive()
  await f.service.flush()
  expect(vi.mocked(f.business.execute).mock.calls[1][0].sessionId).not.toBe(first)
  f.adapter.outcomes = [{ status: 'retry' }]
  await f.receive()
  await f.service.flush()
  f.service.revokeBinding(b.id)
  await f.bind()
  f.advance(2000)
  await f.service.flush()
  expect(
    f.repository.read((s) => [...s.outbox.values()].filter((d) => d.state === 'suppressed'))
  ).toHaveLength(1)
  await f.service.deleteConnection(f.connectionId)
  await expect(f.service.start(f.connectionId)).rejects.toThrow('NOT_FOUND')
})
it('backs off bounded transport reconnects and ignores disconnected stale generations', async () => {
  const f = fixture()
  await f.start()
  const old = f.adapter.context!
  old.disconnected(true)
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.state)).toBe('reconnecting')
  f.advance(1000)
  await f.service.flush()
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.state)).toBe('online')
  old.disconnected(false)
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.state)).toBe('online')
})
it('exhausts known-unsent retry budgets and preserves the domain success', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  f.adapter.outcomes = Array.from({ length: 5 }, () => ({ status: 'retry' as const }))
  await f.receive()
  await f.service.flush()
  for (let n = 0; n < 4; n++) {
    f.advance(60_000)
    await f.service.flush()
  }
  expect(f.repository.read((s) => [...s.outbox.values()][0].state)).toBe('failed')
  expect(f.repository.read((s) => [...s.inbox.values()].find((i) => i.request)!.state)).toBe(
    'succeeded'
  )
  expect(f.business.execute).toHaveBeenCalledTimes(1)
})
it.each([false, true])(
  'consumes text and button confirmations with identical ownership rules (button=%s)',
  async (button) => {
    const f = fixture(button)
    await f.start()
    const binding = await f.bind()
    await f.receive()
    await f.service.flush()
    const sessionRef = f.repository.read((s) => [...s.sessions.keys()][0])
    const token = f.service.identity.issueConfirmation({
      bindingId: binding.id,
      sessionRef,
      eventId: 'original',
      operation: 'save',
      parameterDigest: 'digest'
    })
    const inbound = (): InboundEvent => {
      if (!button) return f.event(`/confirm ${token}`)
      const base = f.event()
      return {
        type: 'interaction',
        token,
        externalEventId: base.externalEventId,
        externalMessageId: base.externalMessageId,
        externalActorId: base.externalActorId,
        externalConversationId: base.externalConversationId,
        scope: base.scope,
        occurredAt: base.occurredAt
      }
    }
    expect(
      (await f.adapter.receive({ ...inbound(), externalConversationId: 'another-route' })).code
    ).toBe('CONFIRMATION_INVALID')
    expect((await f.adapter.receive(inbound())).status).toBe('persisted')
    expect((await f.adapter.receive(inbound())).code).toBe('CONFIRMATION_INVALID')
    expect(f.business.execute).toHaveBeenCalledTimes(1)
    expect(
      f.repository.read((s) =>
        [...s.inbox.values()].some((i) => (JSON.stringify(i.event) ?? '').includes(token))
      )
    ).toBe(false)
  }
)
it('times out a hung send as uncertain and ignores late transport completion', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  await f.receive()
  vi.useFakeTimers()
  try {
    let sent!: (value: { status: 'sent'; externalMessageId: string }) => void
    vi.spyOn(f.adapter, 'send').mockImplementation(
      () =>
        new Promise((resolve) => {
          sent = resolve
        })
    )
    const flushing = f.service.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toBeDefined()
    await vi.advanceTimersByTimeAsync(30_000)
    await flushing
    expect(f.repository.read((s) => [...s.outbox.values()][0].state)).toBe('uncertain')
    sent({ status: 'sent', externalMessageId: 'late' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.repository.read((s) => [...s.outbox.values()][0].state)).toBe('uncertain')
  } finally {
    vi.useRealTimers()
  }
})
it('shuts down within its deadline even if business ignores cancellation, with no late storage write', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  await f.receive()
  vi.useFakeTimers()
  try {
    let resolve!: (value: { status: 'succeeded'; text: string }) => void
    vi.mocked(f.business.execute).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const flushing = f.service.flush()
    await vi.advanceTimersByTimeAsync(0)
    const shutdown = f.service.shutdown()
    await vi.advanceTimersByTimeAsync(3000)
    await shutdown
    f.repository.close()
    resolve({ status: 'succeeded', text: 'late' })
    await flushing
    expect((await f.receive()).code).toBe('STOPPED')
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
it('rejects /new while a request runs, serializes one scope and allows a different scope', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  const original = vi.mocked(f.business.execute).getMockImplementation()!
  let release!: () => void
  let first = true
  vi.mocked(f.business.execute).mockImplementation(async (...args) => {
    if (first) {
      first = false
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    return original(...args)
  })
  await f.receive('first')
  await f.receive('second')
  // Same actor in a separate private conversation scope remains independently routed.
  await f.adapter.receive({
    ...f.event('independent'),
    externalConversationId: 'separate-private-chat'
  })
  const flushing = f.service.flush()
  await vi.waitFor(() => expect(f.business.execute).toHaveBeenCalledTimes(2))
  expect((await f.receive('/new')).code).toBe('BUSY')
  release()
  await flushing
  const requests = vi.mocked(f.business.execute).mock.calls.map(([request]) => request)
  expect(requests.filter((r) => r.text !== 'independent').map((r) => r.sessionId)).toEqual([
    requests[0].sessionId,
    requests[0].sessionId
  ])
})
it('bounds the control queue while preserving immediate cancellation', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  for (let i = 0; i < 4; i++) expect((await f.receive('/help')).status).toBe('persisted')
  expect((await f.receive('/help')).code).toBe('QUEUE_FULL')
  expect((await f.receive('/cancel')).status).toBe('persisted')
})
it('leaves a failed stop in a recoverable error state', async () => {
  const f = fixture()
  await f.start()
  vi.spyOn(f.adapter, 'stop').mockRejectedValueOnce(new Error('SDK stop failure'))
  await expect(f.service.stop(f.connectionId)).rejects.toThrow()
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.state)).toBe('error')
  await f.start()
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.state)).toBe('online')
})
it('does not reconnect after an explicit stop while the old transport is closing', async () => {
  const f = fixture()
  await f.start()
  f.adapter.context!.disconnected(true)
  f.advance(1000)
  let release!: () => void
  vi.spyOn(f.adapter, 'stop').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const flushing = f.service.flush()
  await vi.waitFor(() => expect(release).toBeDefined())
  await f.service.stop(f.connectionId)
  release()
  await flushing
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.state)).toBe('stopped')
})
