import { z } from 'zod'
import {
  adapterCapabilitiesSchema,
  CommunicationError,
  LIMITS,
  type Capability,
  type Receipt
} from './communication-contract'
import { activeBinding, type CommunicationRepository } from './communication-repository'
import { AdapterConnectionError, type CommunicationAdapter } from './communication-adapter'
import type { BusinessPort } from './business-port'
import type { CommunicationEnvironment } from './environment'
import { IdentityBinding } from './identity-binding'
import { InboxReceiver } from './inbox'
import { Outbox } from './outbox'
import { Dispatcher } from './dispatcher'
import { bounded } from './timers'
import { message } from './reply-projection'

type AdapterFactory = (connectionId: string) => CommunicationAdapter
export class CommunicationService {
  readonly identity: IdentityBinding
  private readonly receiver: InboxReceiver
  private readonly outbox: Outbox
  private readonly dispatcher: Dispatcher
  private readonly startAliases = new Set<string>()
  private readonly factories = new Map<string, AdapterFactory>()
  private readonly adapters = new Map<
    string,
    { adapter: CommunicationAdapter; controller: AbortController; generation: number }
  >()
  private closed = false
  private flushing?: Promise<void>
  private delivering?: Promise<void>
  private deliveryRequested = false
  constructor(
    private readonly repository: CommunicationRepository,
    private readonly business: BusinessPort,
    private readonly env: CommunicationEnvironment
  ) {
    this.identity = new IdentityBinding(repository, env)
    this.outbox = new Outbox(repository, env)
    this.receiver = new InboxReceiver(repository, env, this.identity, this.outbox)
    this.dispatcher = new Dispatcher(repository, env, business, this.outbox)
  }
  registerAdapter(id: string, factory: AdapterFactory, options?: { startAsHelp?: boolean }): void {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id) || this.factories.has(id))
      throw new CommunicationError('INVALID_ADAPTER')
    this.factories.set(id, factory)
    if (options?.startAsHelp) this.startAliases.add(id)
  }
  addConnection(
    adapterId: string,
    config: Record<string, string> = {},
    credentialRef?: string
  ): string {
    if (this.closed) throw new CommunicationError('STOPPED')
    if (!this.factories.has(adapterId)) throw new CommunicationError('UNKNOWN_ADAPTER')
    z.record(z.string().max(64), z.string().max(1024))
      .refine((c) => Object.keys(c).length <= 20)
      .parse(config)
    return this.repository.transaction((s) => {
      if (
        [...s.connections.values()].filter(
          (c) => c.enabled || c.state !== 'stopped' || !!c.credentialRef
        ).length >= LIMITS.maxConnections
      )
        throw new CommunicationError('CONNECTION_LIMIT')
      const id = this.env.id()
      s.connections.set(id, {
        id,
        adapterId,
        createdAt: this.env.now(),
        enabled: true,
        generation: 0,
        state: 'stopped',
        attempts: 0,
        cursorVersion: 0,
        config,
        credentialRef
      })
      return id
    })
  }
  async start(id: string): Promise<void> {
    if (this.closed) throw new CommunicationError('STOPPED')
    const connection = this.repository.transaction((s) => {
      const c = s.connections.get(id)
      if (!c || !c.enabled) throw new CommunicationError('NOT_FOUND')
      if (!this.factories.has(c.adapterId)) throw new CommunicationError('UNKNOWN_ADAPTER')
      if (['online', 'starting', 'stopping'].includes(c.state)) return undefined
      c.generation++
      c.state = 'starting'
      c.error = undefined
      c.reconnectAt = undefined
      c.autoStart = true
      return c
    })
    if (!connection) return
    const generation = connection.generation
    const old = this.adapters.get(id)
    if (old) {
      old.controller.abort()
      this.outbox.stopConnection(id)
      try {
        const stopped = await bounded(
          this.env,
          Promise.resolve()
            .then(() => old.adapter.stop())
            .then(() => true),
          LIMITS.shutdownMs,
          () => false
        )
        if (!stopped) throw new CommunicationError('CONNECTION_STOP_FAILED')
      } catch {
        if (!this.closed)
          this.repository.transaction((s) => {
            const c = s.connections.get(id)!
            if (c.generation === generation && c.state === 'starting') {
              c.state = 'error'
              c.error = 'CONNECTION_STOP_FAILED'
            }
          })
        return
      }
      if (this.adapters.get(id) === old) this.adapters.delete(id)
    }
    // An explicit stop or shutdown during cleanup must not start a new transport.
    if (
      this.closed ||
      !this.repository.read((s) => {
        const c = s.connections.get(id)!
        return c.generation === generation && c.state === 'starting'
      })
    )
      return
    const controller = new AbortController()
    let adapter: CommunicationAdapter
    try {
      adapter = this.factories.get(connection.adapterId)!(id)
      adapterCapabilitiesSchema.parse(adapter.capabilities)
      this.adapters.set(id, { adapter, controller, generation })
      const connected = await bounded(
        this.env,
        adapter
          .start({
            signal: controller.signal,
            cursor: connection.cursor,
            receive: (event, cursor) => this.receive(id, generation, event, cursor),
            receiveRejected: async (envelope, cursor) => {
              if (this.closed) return { status: 'failed', code: 'STOPPED' }
              try {
                return this.receiver.receiveRejected(id, generation, envelope, cursor)
              } catch {
                return { status: 'failed', code: 'STORAGE_FAILED' }
              }
            },
            disconnected: (retryable, code, retryAfterMs) =>
              this.disconnected(id, generation, retryable, code, retryAfterMs)
          })
          .then(() => true),
        LIMITS.connectMs,
        () => {
          controller.abort()
          return false
        }
      )
      if (this.closed) return
      if (!connected) {
        this.disconnected(id, generation, true)
        return
      }
      if (controller.signal.aborted) return
      this.repository.transaction((s) => {
        const c = s.connections.get(id)!
        if (c.generation === generation && c.state === 'starting') {
          c.state = 'online'
          c.attempts = 0
        }
      })
    } catch (error) {
      if (!this.closed && !controller.signal.aborted) {
        this.disconnected(
          id,
          generation,
          error instanceof AdapterConnectionError && error.retryable,
          error instanceof AdapterConnectionError ? error.code : undefined,
          error instanceof AdapterConnectionError ? error.retryAfterMs : undefined
        )
        controller.abort()
        const failed = this.adapters.get(id)
        if (failed?.generation === generation) {
          await bounded(
            this.env,
            Promise.resolve()
              .then(() => failed.adapter.stop())
              .catch(() => {}),
            LIMITS.shutdownMs,
            () => {}
          )
        }
      }
    }
  }
  private disconnected(
    id: string,
    generation: number,
    retryable: boolean,
    code?: string,
    retryAfterMs?: number
  ): void {
    if (this.closed) return
    this.repository.transaction((s) => {
      const c = s.connections.get(id)
      if (!c || c.generation !== generation || !['online', 'starting'].includes(c.state)) return
      c.attempts++
      c.state = retryable && c.attempts <= LIMITS.reconnectAttempts ? 'reconnecting' : 'error'
      c.error = code ?? (retryable ? 'CONNECTION_LOST' : 'CONNECTION_FAILED')
      c.reconnectAt =
        c.state === 'reconnecting'
          ? this.env.now() +
            Math.max(
              Number.isFinite(retryAfterMs) && retryAfterMs! > 0 ? retryAfterMs! : 0,
              Math.min(LIMITS.retryMaxMs, LIMITS.retryBaseMs * 2 ** (c.attempts - 1))
            )
          : undefined
    })
  }
  private async receive(
    id: string,
    generation: number,
    event: unknown,
    cursor?: string
  ): Promise<Receipt> {
    if (this.closed) return { status: 'failed', code: 'STOPPED' }
    try {
      const receipt = this.receiver.receive(
        id,
        generation,
        event,
        cursor,
        this.repository.read((s) => this.startAliases.has(s.connections.get(id)!.adapterId))
      )
      if (receipt.status === 'persisted' && receipt.requestId) {
        const inbox = this.repository.read((s) =>
          [...s.inbox.values()].find((i) => i.receipt.requestId === receipt.requestId)
        )!
        if (
          inbox.state === 'queued' &&
          inbox.event?.type === 'text' &&
          /^\/cancel(?:\s|$)/u.test(inbox.event.text)
        ) {
          try {
            const targetId = inbox.event.text.slice(7).trim() || undefined
            if (targetId) z.uuid().parse(targetId)
            const active = this.receiver.cancel(inbox.bindingId!, inbox.scopeKey, targetId)
            for (const requestId of active) this.dispatcher.cancel(requestId)
            this.dispatcher.finish(inbox.id, {
              status: 'succeeded',
              text: message('cancelled', inbox.languages!.uiLanguage)
            })
          } catch {
            this.dispatcher.finish(inbox.id, { status: 'failed' })
          }
        }
      }
      return receipt
    } catch {
      this.env.diagnostics({ code: 'RECEIVE_FAILED', connectionId: id })
      return { status: 'failed', code: 'STORAGE_FAILED' }
    }
  }
  async stop(id: string): Promise<void> {
    const connection = this.repository.transaction((s) => {
      const c = s.connections.get(id)
      if (!c) throw new CommunicationError('NOT_FOUND')
      if (c.state === 'stopped') return undefined
      c.generation++
      c.state = 'stopping'
      c.reconnectAt = undefined
      c.autoStart = false
      return c
    })
    if (!connection) return
    const active = this.adapters.get(id)
    active?.controller.abort()
    this.outbox.stopConnection(id)
    // Stop receiving first. Queued tasks and saved deliveries remain for a later start.
    try {
      const stopped = await bounded(
        this.env,
        Promise.resolve()
          .then(() => active?.adapter.stop())
          .then(() => true),
        LIMITS.shutdownMs,
        () => false
      )
      if (!stopped) throw new CommunicationError('CONNECTION_STOP_FAILED')
      if (this.adapters.get(id) === active) this.adapters.delete(id)
    } catch {
      if (!this.closed)
        this.repository.transaction((s) => {
          const c = s.connections.get(id)!
          if (c.generation === connection.generation) {
            c.state = 'error'
            c.error = 'CONNECTION_STOP_FAILED'
          }
        })
      throw new CommunicationError('CONNECTION_STOP_FAILED')
    }
    if (!this.closed)
      this.repository.transaction((s) => {
        const c = s.connections.get(id)!
        if (c.generation === connection.generation) c.state = 'stopped'
      })
  }
  async deleteConnection(id: string): Promise<void> {
    const bindings = this.repository.transaction((s) => {
      const connection = s.connections.get(id)
      if (!connection) throw new CommunicationError('NOT_FOUND')
      connection.enabled = false
      for (const c of s.challenges.values()) if (c.connectionId === id) c.consumed = true
      return [...s.bindings.values()]
        .filter((b) => b.connectionId === id && !b.revoked)
        .map((b) => b.id)
    })
    bindings.forEach((binding) => this.revokeBinding(binding))
    await this.stop(id)
  }
  createChallenge(
    id: string,
    capabilities: Capability[]
  ): ReturnType<IdentityBinding['createChallenge']> {
    return this.identity.createChallenge(id, capabilities)
  }
  confirmBinding(id: string): ReturnType<IdentityBinding['confirm']> {
    return this.identity.confirm(id)
  }
  revokeBinding(id: string): void {
    const active = this.repository.transaction((s) => {
      const b = s.bindings.get(id)
      if (!b) throw new CommunicationError('NOT_FOUND')
      b.revoked = true
      b.version++
      const requests: string[] = []
      for (const i of s.inbox.values())
        if (i.bindingId === id) {
          if (['running', 'dispatching'].includes(i.state) && i.request)
            requests.push(i.request.requestId)
          if (i.state === 'queued') i.state = 'cancelled'
        }
      for (const session of s.sessions.values())
        if (session.bindingId === id) session.active = false
      for (const c of s.confirmations.values()) if (c.bindingId === id) c.consumed = true
      for (const d of s.outbox.values()) this.outbox.suppress(s, d)
      return requests
    })
    active.forEach((id) => this.dispatcher.cancel(id))
  }
  cancelRequest(bindingId: string, requestId: string): void {
    const i = this.repository.read((s) =>
      [...s.inbox.values()].find(
        (i) => i.bindingId === bindingId && i.receipt.requestId === requestId
      )
    )
    if (!i) throw new CommunicationError('OWNER_MISMATCH')
    this.receiver
      .cancel(bindingId, i.scopeKey, requestId)
      .forEach((id) => this.dispatcher.cancel(id))
  }
  resolveDelivery(id: string, action: 'retry' | 'suppress', acknowledgeDuplicate = false): void {
    this.outbox.resolve(id, action, acknowledgeDuplicate)
  }
  async recover(): Promise<void> {
    const interrupted = this.repository.transaction((s) => {
      for (const c of s.connections.values()) {
        c.generation++
        c.state = 'stopped'
        c.reconnectAt = undefined
      }
      for (const i of s.inbox.values())
        if (['dispatching', 'running'].includes(i.state)) i.state = 'interrupted'
      this.outbox.recover(s)
      return [...s.inbox.values()].filter((i) => i.state === 'interrupted')
    })
    for (const i of interrupted) {
      const authorized = this.repository.read(
        (s) => !!activeBinding(s, i.bindingId, i.bindingVersion)
      )
      if (!authorized) continue
      let result
      try {
        result = i.request ? await this.business.recover(i.request) : undefined
      } catch {
        /* retain interrupted */
      }
      if (this.closed) return
      if (result) this.dispatcher.finish(i.id, result)
      else
        this.repository.transaction((s) =>
          this.outbox.enqueue(
            s,
            s.inbox.get(i.id)!,
            message('interrupted', i.languages!.uiLanguage)
          )
        )
    }
  }
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.flushing)
      this.flushing = this.runFlush().finally(() => {
        this.flushing = undefined
      })
    // Delivery ticks must keep progressing while the dispatcher awaits business.
    return Promise.all([this.flushing, this.flushDeliveries()]).then(() => {})
  }
  private flushDeliveries(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.deliveryRequested = true
    if (!this.delivering) this.delivering = this.runDeliveries()
    return this.delivering
  }
  private async runDeliveries(): Promise<void> {
    try {
      while (!this.closed && this.deliveryRequested) {
        // A tick or business completion during a send requests another snapshot.
        this.deliveryRequested = false
        await this.outbox.flush((id) =>
          this.repository.read((s) => s.connections.get(id)?.state === 'online')
            ? this.adapters.get(id)?.adapter
            : undefined
        )
      }
    } finally {
      this.delivering = undefined
    }
  }
  private async runFlush(): Promise<void> {
    const due = this.repository.read((s) =>
      [...s.connections.values()]
        .filter((c) => c.state === 'reconnecting' && c.reconnectAt! <= this.env.now())
        .map((c) => ({ id: c.id, generation: c.generation }))
    )
    for (const { id, generation } of due) {
      if (this.closed) return
      const stillDue = this.repository.read((s) => {
        const c = s.connections.get(id)
        return c?.generation === generation && c.state === 'reconnecting'
      })
      if (stillDue) await this.start(id)
    }
    await this.dispatcher.flush()
    await this.flushDeliveries()
  }
  cleanup(): void {
    const now = this.env.now()
    this.repository.transaction((s) => {
      for (const c of s.challenges.values()) if (c.expiresAt <= now) s.challenges.delete(c.id)
      for (const c of s.confirmations.values()) if (c.expiresAt <= now) s.confirmations.delete(c.id)
      for (const i of s.inbox.values()) {
        // Expiry applies even when a connection stays offline indefinitely.
        if (['queued', 'received'].includes(i.state) && i.expiresAt <= now) {
          i.state = 'expired'
          i.error = 'EXPIRED'
          if (i.languages)
            this.outbox.enqueue(
              s,
              i,
              message('rejected', i.languages.uiLanguage, { code: 'EXPIRED' })
            )
        }
        if (!['queued', 'received', 'dispatching', 'running'].includes(i.state)) {
          if (now - i.receivedAt > LIMITS.bodyRetentionMs) {
            i.event = undefined
            if (i.request) i.request.text = ''
          }
          if (now - i.receivedAt > LIMITS.tombstoneMs) s.inbox.delete(i.id)
        }
      }
      for (const d of s.outbox.values()) {
        this.outbox.suppress(s, d)
        if (
          now - d.createdAt > LIMITS.bodyRetentionMs &&
          !['pending', 'sending', 'retry_wait'].includes(d.state)
        )
          s.outbox.delete(d.id)
      }
    })
  }
  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // Invalidate callbacks before any await; no asynchronous callback can use closed storage.
    const ids = this.repository.transaction((s) => {
      for (const c of s.connections.values()) {
        c.generation++
        c.state = 'stopped'
      }
      return [...s.connections.keys()]
    })
    this.dispatcher.close()
    this.outbox.close()
    const stops = ids.map((id) => {
      const active = this.adapters.get(id)
      active?.controller.abort()
      return Promise.resolve().then(() => active?.adapter.stop())
    })
    await bounded(
      this.env,
      Promise.allSettled([...stops, this.flushing, this.delivering]).then(() => {}),
      LIMITS.shutdownMs,
      () => {}
    )
    this.adapters.clear()
  }
}
