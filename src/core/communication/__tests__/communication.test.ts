import type { InboundEvent, Receipt } from '../communication-contract'
import type { Binding, Inbox } from '../communication-repository'
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

it('durably rejects transport envelopes, shares event uniqueness and atomically records conflicts and cursors', async () => {
  const f = fixture()
  await f.start()
  const envelope = { externalEventId: 'unknown', kind: 'invalid' as const, digest: 'a'.repeat(64) }
  const context = f.adapter.context!
  const receipt = await context.receiveRejected(envelope, 'next-1')
  expect(receipt).toEqual({ status: 'rejected', code: 'UNSUPPORTED_INPUT' })
  expect(await context.receiveRejected(envelope, 'next-1')).toEqual(receipt)
  expect((await f.adapter.receive(f.event('hello', 'alice', 'unknown'), 'next-2')).code).toBe(
    'EVENT_CONFLICT'
  )
  const saved = f.repository.read((s) => ({
    connection: s.connections.get(f.connectionId)!,
    inbox: [...s.inbox.values()]
  }))
  expect(saved.connection.cursor).toBe('next-2')
  expect(saved.inbox).toHaveLength(1)
  expect(saved.inbox[0].conflictDigests).toHaveLength(1)
  expect(saved.inbox[0].event).toBeUndefined()
  expect(saved.inbox[0].actorId).toBeUndefined()
  expect(f.repository.read((s) => s.outbox.size + s.sessions.size)).toBe(0)
  f.repository.close()
  expect(
    (await context.receiveRejected({ ...envelope, externalEventId: 'new' }, 'next-3')).status
  ).toBe('failed')
})

it('ignores mutable display names when deduplicating an event', async () => {
  const f = fixture()
  await f.start()
  const event = f.event()
  const receipt = await f.adapter.receive({ ...event, displayName: 'Alice' })
  expect(await f.adapter.receive({ ...event, displayName: 'Changed' })).toEqual(receipt)
})

it('persists an explicit start marker that survives restarts and is cleared by stop', async () => {
  const f = fixture()
  await f.start()
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.autoStart)).toBe(true)
  const persisted = new SqliteCommunicationRepository(f.db)
  expect(persisted.read((s) => s.connections.get(f.connectionId)!.autoStart)).toBe(true)
  persisted.close()
  await f.service.recover()
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.autoStart)).toBe(true)
  await f.start()
  await f.service.stop(f.connectionId)
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.autoStart)).toBe(false)
})

it('does not declare a timed out stop successful or replace its consumer', async () => {
  const f = fixture()
  await f.start()
  vi.useFakeTimers()
  try {
    vi.spyOn(f.adapter, 'stop').mockImplementation(() => new Promise(() => {}))
    const start = vi.spyOn(f.adapter, 'start')
    const stopped = expect(f.service.stop(f.connectionId)).rejects.toThrow('CONNECTION_STOP_FAILED')
    await vi.advanceTimersByTimeAsync(3000)
    await stopped
    expect(f.repository.read((s) => s.connections.get(f.connectionId)!.state)).toBe('error')
    const restarted = f.start()
    await vi.advanceTimersByTimeAsync(3000)
    await restarted
    expect(start).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

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
it('expires offline queued messages, retains de-duplication and eventually removes their bodies and tombstones', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  const event = f.event('Private offline message')
  const receipt = await f.adapter.receive(event)
  const record = (): Inbox | undefined =>
    f.repository.read((s) => [...s.inbox.values()].find((i) => i.eventId === event.externalEventId))
  await f.service.stop(f.connectionId)
  f.advance(299_999)
  f.service.cleanup()
  expect(record()?.state).toBe('queued')
  f.advance(1)
  f.service.cleanup()
  expect(record()?.state).toBe('expired')
  expect(record()?.error).toBe('EXPIRED')
  await f.start()
  expect(await f.adapter.receive(event)).toEqual(receipt)
  await f.service.flush()
  expect(f.business.execute).not.toHaveBeenCalled()
  expect(f.adapter.sent.map((p) => p.text).join('')).toContain('EXPIRED')
  await f.service.stop(f.connectionId)
  f.advance(8 * 86400_000)
  f.service.cleanup()
  expect(record()?.event).toBeUndefined()
  expect(record()?.receipt).toEqual(receipt)
  f.advance(23 * 86400_000)
  f.service.cleanup()
  expect(record()).toBeUndefined()
  await f.start()
  expect((await f.adapter.receive(event)).code).toBe('EXPIRED')
  await f.service.flush()
  expect(f.business.execute).not.toHaveBeenCalled()
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
it('delivers completed replies on later ticks while business is still running, without duplicate sends', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  let release!: () => void
  vi.mocked(f.business.execute).mockImplementation(async (request) => {
    if (request.text === 'slow')
      await new Promise<void>((resolve) => {
        release = resolve
      })
    return { status: 'succeeded', text: 'Safe answer' }
  })
  await f.receive('fast')
  await f.receive('slow')
  const flushing = f.service.flush()
  await vi.waitFor(() => expect(release).toBeDefined())
  let completeSend!: () => void
  const send = vi.spyOn(f.adapter, 'send').mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      completeSend = resolve
    })
    return { status: 'sent', externalMessageId: 'saved-reply' }
  })
  const tick = f.service.flush()
  const concurrentTick = f.service.flush()
  try {
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(f.business.execute).toHaveBeenCalledTimes(2)
    completeSend()
    await vi.waitFor(() =>
      expect(f.repository.read((s) => [...s.outbox.values()][0].state)).toBe('sent')
    )
  } finally {
    send.mockRestore()
    completeSend?.()
    release()
    await Promise.all([flushing, tick, concurrentTick])
  }
})
it.each([true, false])(
  'releases the old transport before manual restart (retryable=%s)',
  async (retryable) => {
    const f = fixture()
    await f.start()
    const old = f.adapter.context!
    const start = vi.spyOn(f.adapter, 'start')
    let release!: () => void
    const stop = vi.spyOn(f.adapter, 'stop').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    old.disconnected(retryable)
    const restarting = f.service.start(f.connectionId)
    try {
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
      expect(old.signal.aborted).toBe(true)
      expect(start).not.toHaveBeenCalled()
      expect((await old.receive(f.event())).code).toBe('STOPPED')
    } finally {
      release?.()
      await restarting
    }
    expect(start).toHaveBeenCalledTimes(1)
    expect(f.repository.read((s) => s.connections.get(f.connectionId)!.state)).toBe('online')
  }
)
it('retains the old adapter on restart cleanup failure instead of replacing it', async () => {
  const f = fixture()
  await f.start()
  const old = f.adapter.context!
  const start = vi.spyOn(f.adapter, 'start')
  const stop = vi.spyOn(f.adapter, 'stop').mockRejectedValueOnce(new Error('SDK stop failure'))
  old.disconnected(true)
  await f.start()
  expect(start).not.toHaveBeenCalled()
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.error)).toBe(
    'CONNECTION_STOP_FAILED'
  )
  await f.start()
  expect(stop).toHaveBeenCalledTimes(2)
  expect(start).toHaveBeenCalledTimes(1)
})
it('bounds restart cleanup and does not replace a transport whose stop timed out', async () => {
  const f = fixture()
  await f.start()
  const old = f.adapter.context!
  const start = vi.spyOn(f.adapter, 'start')
  vi.spyOn(f.adapter, 'stop').mockImplementation(() => new Promise(() => {}))
  old.disconnected(true)
  vi.useFakeTimers()
  try {
    const restarting = f.start()
    await vi.advanceTimersByTimeAsync(2999)
    expect(f.repository.read((s) => s.connections.get(f.connectionId)!.state)).toBe('starting')
    await vi.advanceTimersByTimeAsync(1)
    await restarting
    expect(old.signal.aborted).toBe(true)
    expect(start).not.toHaveBeenCalled()
    expect(f.repository.read((s) => s.connections.get(f.connectionId)!.error)).toBe(
      'CONNECTION_STOP_FAILED'
    )
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
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
it.each([false, true])(
  'does not reconnect after an explicit stop while the old transport is closing (manual=%s)',
  async (manual) => {
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
    const flushing = manual ? f.start() : f.service.flush()
    await vi.waitFor(() => expect(release).toBeDefined())
    await f.service.stop(f.connectionId)
    release()
    await flushing
    expect(f.repository.read((s) => s.connections.get(f.connectionId)!.state)).toBe('stopped')
  }
)
it('keeps transport rejection and its cursor in one SQLite transaction and bounds retained tombstones', async () => {
  const f = fixture()
  await f.start()
  const envelope = { externalEventId: 'bad', kind: 'invalid' as const, digest: 'a'.repeat(64) }
  f.db.exec(
    "CREATE TRIGGER reject_inbox BEFORE INSERT ON communication_inbox BEGIN SELECT RAISE(ABORT, 'disk failure'); END"
  )
  expect(await f.adapter.context!.receiveRejected(envelope, 'next')).toEqual({
    status: 'failed',
    code: 'STORAGE_FAILED'
  })
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.cursor)).toBeUndefined()
  f.db.exec('DROP TRIGGER reject_inbox')
  await f.adapter.context!.receiveRejected(envelope, 'next')
  f.advance(31 * 86400_000)
  f.service.cleanup()
  expect(f.repository.read((s) => s.inbox.size)).toBe(0)
})
it('treats /start as help only for explicitly configured adapters and never consumes start parameters as binding codes', async () => {
  const f = fixture()
  f.service.registerAdapter('telegram', () => f.adapter, { startAsHelp: true })
  const id = f.service.addConnection('telegram')
  await f.service.start(id)
  const challenge = f.service.createChallenge(id, ['chat'])
  expect((await f.receive(`/start ${challenge.code}`)).code).toBe('UNBOUND')
  expect(f.repository.read((s) => JSON.stringify([...s.inbox.values()]))).not.toContain(
    challenge.code
  )
  expect(f.repository.read((s) => s.challenges.get(challenge.challengeId)!.actor)).toBeUndefined()
  await f.receive(`/bind ${challenge.code}`)
  f.service.confirmBinding(challenge.challengeId)
  expect((await f.receive('/start')).status).toBe('persisted')
  expect((await f.receive('/start parameter')).code).toBe('CAPABILITY_DENIED')
  await f.service.flush()
  expect(f.business.execute).not.toHaveBeenCalled()
  expect(f.adapter.sent.map((p) => p.text).join('')).toContain('Commands:')
})
it('does not acknowledge transport rejection on capacity exhaustion, including on existing v15 databases', async () => {
  const f = fixture()
  await f.start()
  expect(f.db.pragma('user_version', { simple: true })).toBe(15)
  f.repository.transaction((s) => {
    for (let n = 0; n < 10000; n++) {
      const id = randomUUID()
      s.inbox.set(id, {
        id,
        connectionId: f.connectionId,
        eventId: `old-${n}`,
        digest: 'd',
        receipt: { status: 'rejected' },
        state: 'rejected',
        receivedAt: Date.now(),
        expiresAt: 0,
        scopeKey: '',
        control: false
      })
    }
  })
  expect(
    await f.adapter.context!.receiveRejected(
      { externalEventId: 'overflow', kind: 'invalid', digest: 'a'.repeat(64) },
      'must-not-advance'
    )
  ).toEqual({ status: 'failed', code: 'BACKPRESSURE' })
  expect(f.repository.read((s) => s.connections.get(f.connectionId)!.cursor)).toBeUndefined()
})
it('does not route whitespace-prefixed commands into chat or persist misplaced binding secrets', async () => {
  const f = fixture()
  await f.start()
  await f.bind()
  expect((await f.receive('  /vocabulary denied')).code).toBe('CAPABILITY_DENIED')
  expect((await f.receive('  /bind SECRET_BINDING_CODE')).code).toBe('CHALLENGE_INVALID')
  await f.service.flush()
  expect(f.business.execute).not.toHaveBeenCalled()
  expect(f.repository.read((s) => JSON.stringify([...s.inbox.values()]))).not.toContain(
    'SECRET_BINDING_CODE'
  )
})
it('deduplicates v15 event digests that still include display metadata', async () => {
  const f = fixture()
  await f.start()
  const event = { ...f.event(), displayName: 'Alice' }
  const receipt = await f.adapter.receive(event)
  f.repository.transaction((s) => {
    const inbox = [...s.inbox.values()][0]
    inbox.digest = createHash('sha256').update(JSON.stringify(inbox.event)).digest('hex')
  })
  expect(await f.adapter.receive({ ...event, displayName: 'Changed' }, 'durable-next')).toEqual(
    receipt
  )
})
it('never shortens a platform reconnect delay to the local backoff cap', async () => {
  const f = fixture()
  await f.start()
  const start = vi.spyOn(f.adapter, 'start')
  f.adapter.context!.disconnected(true, 'TELEGRAM_RATE_LIMITED', 120000)
  f.advance(60000)
  await f.service.flush()
  expect(start).not.toHaveBeenCalled()
  f.advance(60000)
  await f.service.flush()
  expect(start).toHaveBeenCalledTimes(1)
})
