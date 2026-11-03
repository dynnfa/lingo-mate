import { bounded } from './timers'
import { z } from 'zod'
import {
  CommunicationError,
  encodedPartSchema,
  sendResultSchema,
  LIMITS,
  type SendResult
} from './communication-contract'
import {
  activeBinding,
  type CommunicationRepository,
  type CommunicationState,
  type Delivery,
  type Inbox
} from './communication-repository'
import type { CommunicationAdapter } from './communication-adapter'
import type { CommunicationEnvironment } from './environment'

export class Outbox {
  private closed = false
  private readonly sends = new Map<string, AbortController>()
  constructor(
    private readonly repository: CommunicationRepository,
    private readonly env: CommunicationEnvironment
  ) {}
  enqueue(s: CommunicationState, inbox: Inbox, text: string): void {
    if (!inbox.bindingId || !inbox.event) return
    const requestId = inbox.receipt.requestId ?? inbox.id
    if ([...s.outbox.values()].some((d) => d.requestId === requestId)) return
    const { externalActorId, externalConversationId, externalThreadId } = inbox.event
    const id = this.env.id()
    s.outbox.set(id, {
      id,
      requestId,
      connectionId: inbox.connectionId,
      bindingId: inbox.bindingId,
      bindingVersion: inbox.bindingVersion!,
      target: { externalActorId, externalConversationId, externalThreadId },
      text: text.slice(0, LIMITS.reply),
      createdAt: this.env.now(),
      expiresAt: inbox.receivedAt + LIMITS.deliveryMs,
      state: 'pending',
      parts: []
    })
  }
  suppress(s: CommunicationState, delivery: Delivery): boolean {
    if (delivery.state === 'sent') return false
    const binding = activeBinding(s, delivery.bindingId, delivery.bindingVersion)
    if (
      !binding ||
      !s.connections.get(delivery.connectionId)?.enabled ||
      delivery.expiresAt <= this.env.now() ||
      binding.connectionId !== delivery.connectionId ||
      binding.externalActorId !== delivery.target.externalActorId
    ) {
      delivery.state = 'suppressed'
      for (const part of delivery.parts) if (part.state !== 'sent') part.state = 'suppressed'
      this.sends.get(delivery.id)?.abort()
      return true
    }
    return false
  }
  async flush(adapterFor: (id: string) => CommunicationAdapter | undefined): Promise<void> {
    const ids = this.repository.read((s) => [...s.outbox.keys()])
    for (const id of ids) {
      if (this.closed) return
      let delivery = this.repository.transaction((s) => {
        const d = s.outbox.get(id)!
        this.suppress(s, d)
        return d
      })
      if (!['pending', 'retry_wait'].includes(delivery.state)) continue
      const adapter = adapterFor(delivery.connectionId)
      if (!adapter) continue
      if (!delivery.encodingVersion) {
        try {
          const encoded = z
            .array(encodedPartSchema)
            .min(1)
            .max(LIMITS.maxParts)
            .parse(adapter.encode(delivery.text))
          if (encoded.some((p) => p.text.length > adapter.capabilities.maxTextLength))
            throw new Error('Encoding exceeds capability')
          delivery = this.repository.transaction((s) => {
            const d = s.outbox.get(id)!
            if (this.suppress(s, d)) return d
            d.encodingVersion = adapter.capabilities.encodingVersion
            d.parts = encoded.map((part) => ({
              id: this.env.id(),
              encoded: part,
              state: 'pending',
              attempts: 0,
              nextAt: 0
            }))
            return d
          })
        } catch {
          this.repository.transaction((s) => {
            s.outbox.get(id)!.state = 'failed'
          })
          this.env.diagnostics({
            code: 'ENCODING_FAILED',
            deliveryId: id,
            connectionId: delivery.connectionId
          })
          continue
        }
      }
      // Never re-encode an already persisted version with a new adapter version.
      if (adapter.capabilities.encodingVersion !== delivery.encodingVersion) continue
      for (const part of delivery.parts) {
        if (this.closed || ['uncertain', 'failed', 'suppressed'].includes(part.state)) break
        if (part.state === 'sent') continue
        if (part.nextAt > this.env.now()) break
        const claimed = this.repository.transaction((s) => {
          const d = s.outbox.get(id)!,
            p = d.parts.find((p) => p.id === part.id)!
          if (
            this.suppress(s, d) ||
            !['pending', 'retry_wait'].includes(p.state) ||
            s.connections.get(d.connectionId)?.state !== 'online'
          )
            return false
          p.state = 'sending'
          p.attempts++
          d.state = 'sending'
          return true
        })
        if (!claimed) break
        const controller = new AbortController()
        this.sends.set(id, controller)
        let result: SendResult
        try {
          result = await bounded(
            this.env,
            adapter.send(
              delivery.target,
              part.encoded,
              { deliveryId: id, partId: part.id },
              controller.signal
            ),
            LIMITS.sendMs,
            () => {
              controller.abort()
              return { status: 'uncertain' as const }
            }
          )
          result = sendResultSchema.parse(result)
        } catch {
          result = { status: 'uncertain' }
        }
        this.sends.delete(id)
        if (this.closed) return
        this.repository.transaction((s) => {
          const d = s.outbox.get(id)!,
            p = d.parts.find((p) => p.id === part.id)!
          if (this.suppress(s, d) || p.state !== 'sending') return
          if (result.status === 'sent') {
            p.state = 'sent'
            p.externalMessageId = result.externalMessageId
          } else if (result.status === 'retry' && p.attempts < LIMITS.sendAttempts) {
            p.state = 'retry_wait'
            p.nextAt =
              this.env.now() +
              Math.max(
                result.retryAfterMs ?? 0,
                Math.min(LIMITS.retryMaxMs, LIMITS.retryBaseMs * 2 ** (p.attempts - 1))
              )
          } else p.state = result.status === 'uncertain' ? 'uncertain' : 'failed'
          d.state = d.parts.every((p) => p.state === 'sent')
            ? 'sent'
            : p.state === 'sent'
              ? 'pending'
              : p.state
        })
        if (result.status !== 'sent') break
      }
    }
  }
  stopConnection(connectionId: string): void {
    this.repository.transaction((s) => {
      for (const d of s.outbox.values())
        if (d.connectionId === connectionId && d.state === 'sending') {
          this.sends.get(d.id)?.abort()
          d.state = 'uncertain'
          for (const p of d.parts) if (p.state === 'sending') p.state = 'uncertain'
        }
    })
  }
  resolve(id: string, action: 'retry' | 'suppress', acknowledgeDuplicate: boolean): void {
    this.repository.transaction((s) => {
      const d = s.outbox.get(id)
      if (!d) throw new CommunicationError('NOT_FOUND')
      if (action === 'suppress') {
        d.state = 'suppressed'
        for (const p of d.parts) if (p.state !== 'sent') p.state = 'suppressed'
        this.sends.get(id)?.abort()
        return
      }
      if (!['failed', 'uncertain'].includes(d.state) || this.suppress(s, d))
        throw new CommunicationError('DELIVERY_NOT_RETRYABLE')
      if (d.state === 'uncertain' && !acknowledgeDuplicate)
        throw new CommunicationError('DUPLICATE_ACK_REQUIRED')
      d.state = 'pending'
      for (const p of d.parts)
        if (p.state !== 'sent') {
          p.state = 'pending'
          p.attempts = 0
          p.nextAt = 0
        }
    })
  }
  recover(s: CommunicationState): void {
    for (const d of s.outbox.values()) {
      for (const p of d.parts) if (p.state === 'sending') p.state = 'uncertain'
      if (d.state === 'sending') d.state = 'uncertain'
      this.suppress(s, d)
    }
  }
  close(): void {
    this.closed = true
    for (const controller of this.sends.values()) controller.abort()
    this.repository.transaction((s) => this.recover(s))
  }
}
