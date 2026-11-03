import {
  CommunicationError,
  inboundEventSchema,
  rejectedEnvelopeSchema,
  languagesSchema,
  LIMITS,
  type Capability,
  type Receipt
} from './communication-contract'
import {
  activeBinding,
  type CommunicationRepository,
  type CommunicationState,
  type Inbox
} from './communication-repository'
import type { IdentityBinding } from './identity-binding'
import type { CommunicationEnvironment } from './environment'
import type { Outbox } from './outbox'
import { message } from './reply-projection'
export function operationFor(text: string): Capability | undefined {
  if (text.startsWith('/')) return /^\/sentence\s+\S/u.test(text) ? 'sentence' : undefined
  return 'chat'
}
export const controlFor = (text: string): boolean => /^\/(new|cancel|help)(?:\s|$)/u.test(text)
export class InboxReceiver {
  constructor(
    private readonly repository: CommunicationRepository,
    private readonly env: CommunicationEnvironment,
    private readonly identity: IdentityBinding,
    private readonly outbox: Outbox
  ) {}
  receive(
    connectionId: string,
    generation: number,
    raw: unknown,
    cursor?: string,
    startAsHelp = false
  ): Receipt {
    const parsed = inboundEventSchema.safeParse(raw)
    if (!parsed.success || (cursor !== undefined && cursor.length > LIMITS.cursor))
      return { status: 'failed', code: 'INVALID_INPUT' }
    const event = parsed.data
    const digest = this.env.digest(JSON.stringify({ ...event, displayName: undefined }))
    if (startAsHelp && event.type === 'text' && /^\/start\s*$/u.test(event.text))
      event.text = '/help'
    return this.repository.transaction((s) => {
      const connection = s.connections.get(connectionId)
      if (
        !connection ||
        !connection.enabled ||
        connection.generation !== generation ||
        !['starting', 'online'].includes(connection.state)
      )
        return { status: 'failed', code: 'STOPPED' }
      const duplicate = this.duplicate(s, connectionId, event.externalEventId, digest, cursor)
      if (duplicate) return duplicate
      if (s.inbox.size >= LIMITS.records) return { status: 'failed', code: 'BACKPRESSURE' }
      const now = this.env.now(),
        id = this.env.id()
      const text = event.type === 'text' ? event.text : ''
      const binding = [...s.bindings.values()].find(
        (b) =>
          !b.revoked &&
          b.connectionId === connectionId &&
          b.externalActorId === event.externalActorId
      )
      const inbox: Inbox = {
        id,
        connectionId,
        eventId: event.externalEventId,
        digest,
        event,
        receivedAt: now,
        expiresAt: event.occurredAt + LIMITS.messageAgeMs,
        actorId: event.externalActorId,
        scopeKey: '',
        control: controlFor(text),
        state: 'received',
        receipt: { status: 'persisted' },
        bindingId: binding?.id,
        bindingVersion: binding?.version
      }
      s.inbox.set(id, inbox)
      if (cursor !== undefined) {
        connection.cursor = cursor
        connection.cursorVersion++
      }
      const reject = (code: string): Receipt => {
        inbox.state = code === 'EXPIRED' ? 'expired' : 'rejected'
        inbox.error = code
        inbox.receipt = { status: 'rejected', code }
        if (binding)
          this.outbox.enqueue(
            s,
            inbox,
            message('rejected', this.env.languages().uiLanguage, { code })
          )
        if (
          event.type === 'interaction' ||
          /^\/(bind|confirm)(?:\s|$)/u.test(text.trimStart()) ||
          (startAsHelp && /^\/start(?:\s|$)/u.test(text))
        )
          inbox.event = undefined
        return inbox.receipt
      }
      if (event.occurredAt > now + LIMITS.futureSkewMs || inbox.expiresAt <= now)
        return reject('EXPIRED')
      if (event.scope !== 'private' || event.externalThreadId) return reject('UNSUPPORTED_SCOPE')
      const recent = [...s.inbox.values()].filter(
        (i) => i.id !== id && now - i.receivedAt < 60_000 && i.connectionId === connectionId
      )
      const account = recent.filter((i) => i.actorId === event.externalActorId)
      if (
        inbox.control
          ? account.filter((i) => i.control).length >= LIMITS.controlsPerMinute
          : recent.filter((i) => !i.control).length >= LIMITS.connectionPerMinute ||
            account.filter((i) => !i.control).length >= LIMITS.accountPerMinute
      )
        return reject('RATE_LIMITED')
      if (event.type === 'unsupported') return reject('UNSUPPORTED_INPUT')
      if (/^\/bind(?:\s|$)/u.test(text)) {
        // The digest supports de-duplication, but never persist plaintext challenge codes.
        inbox.event = undefined
        inbox.state = 'rejected'
        const code = text.slice(6).trim()
        const accepted =
          !binding &&
          this.identity.submit(s, connectionId, event.externalActorId, code, event.displayName)
        inbox.receipt = accepted
          ? { status: 'persisted', code: 'AWAITING_CONFIRMATION' }
          : { status: 'rejected', code: 'CHALLENGE_INVALID' }
        return inbox.receipt
      }
      if (!binding) return reject('UNBOUND')
      inbox.languages = languagesSchema.parse(this.env.languages())
      inbox.scopeKey = JSON.stringify([
        connectionId,
        binding.id,
        event.externalConversationId,
        event.externalThreadId ?? '',
        inbox.languages.targetLanguage
      ])
      if (event.type === 'interaction' || /^\/confirm\s/u.test(text)) {
        const token = event.type === 'interaction' ? event.token : text.slice(9).trim()
        const ticket = [...s.confirmations.values()].find(
          (c) => c.digest === this.env.digest(token) && !c.consumed
        )
        const session = ticket ? s.sessions.get(ticket.sessionRef) : undefined
        if (
          !ticket ||
          !session ||
          session.route.externalActorId !== event.externalActorId ||
          session.route.externalConversationId !== event.externalConversationId ||
          session.languages.targetLanguage !== inbox.languages.targetLanguage
        )
          return reject('CONFIRMATION_INVALID')
        try {
          this.identity.consume(s, token, {
            bindingId: binding.id,
            sessionRef: session.id,
            eventId: ticket.eventId,
            operation: ticket.operation,
            parameterDigest: ticket.parameterDigest
          })
        } catch {
          return reject('CONFIRMATION_INVALID')
        }
        inbox.state = 'succeeded'
        this.outbox.enqueue(s, inbox, message('confirmed', inbox.languages.uiLanguage))
        // Retain only the digest of the inbound confirmation token.
        inbox.event = undefined
        return inbox.receipt
      }
      if (
        !inbox.control &&
        (!operationFor(text) || !binding.capabilities.includes(operationFor(text)!))
      )
        return reject('CAPABILITY_DENIED')
      if (
        text === '/new' &&
        [...s.inbox.values()].some(
          (i) =>
            i.id !== id &&
            i.scopeKey === inbox.scopeKey &&
            ['dispatching', 'running'].includes(i.state)
        )
      )
        return reject('BUSY')
      if (
        inbox.control &&
        !/^\/cancel(?:\s|$)/u.test(text) &&
        ([...s.inbox.values()].filter((i) => i.control && i.state === 'queued').length >=
          LIMITS.controlBacklog ||
          [...s.inbox.values()].filter(
            (i) => i.control && i.state === 'queued' && i.scopeKey === inbox.scopeKey
          ).length >= LIMITS.controlsPerSession)
      )
        return reject('QUEUE_FULL')
      if (
        !inbox.control &&
        ([...s.inbox.values()].filter((i) => ['queued', 'received'].includes(i.state)).length >
          LIMITS.backlog ||
          [...s.inbox.values()].filter(
            (i) => i.id !== id && i.scopeKey === inbox.scopeKey && i.state === 'queued'
          ).length >= LIMITS.queuePerSession)
      )
        return reject('QUEUE_FULL')
      inbox.state = 'queued'
      inbox.receipt = { status: 'persisted', requestId: this.env.id() }
      return inbox.receipt
    })
  }
  private duplicate(
    s: CommunicationState,
    connectionId: string,
    eventId: string,
    digest: string,
    cursor?: string
  ): Receipt | undefined {
    const previous = [...s.inbox.values()].find(
      (i) => i.connectionId === connectionId && i.eventId === eventId
    )
    if (!previous) return undefined
    if (cursor !== undefined) {
      const connection = s.connections.get(connectionId)!
      connection.cursor = cursor
      connection.cursorVersion++
    }
    // v15 records may still hash displayName. Compare their retained canonical
    // event before upgrading the digest, without replaying an execution.
    const canonical = previous.event
      ? this.env.digest(JSON.stringify({ ...previous.event, displayName: undefined }))
      : undefined
    if (
      previous.digest === digest ||
      (canonical === digest && previous.digest === this.env.digest(JSON.stringify(previous.event)))
    ) {
      previous.digest = digest
      return previous.receipt
    }
    previous.conflictDigests ??= []
    if (!previous.conflictDigests.includes(digest) && previous.conflictDigests.length < 4)
      previous.conflictDigests.push(digest)
    return { status: 'rejected', code: 'EVENT_CONFLICT' }
  }
  receiveRejected(
    connectionId: string,
    generation: number,
    raw: unknown,
    cursor?: string
  ): Receipt {
    const parsed = rejectedEnvelopeSchema.safeParse(raw)
    if (!parsed.success || (cursor !== undefined && cursor.length > LIMITS.cursor))
      return { status: 'failed', code: 'INVALID_INPUT' }
    const envelope = parsed.data
    const digest = this.env.digest(JSON.stringify(envelope))
    return this.repository.transaction((s) => {
      const connection = s.connections.get(connectionId)
      if (
        !connection ||
        connection.generation !== generation ||
        !connection.enabled ||
        !['starting', 'online'].includes(connection.state)
      )
        return { status: 'failed', code: 'STOPPED' }
      const duplicate = this.duplicate(s, connectionId, envelope.externalEventId, digest, cursor)
      if (duplicate) return duplicate
      if (s.inbox.size >= LIMITS.records) return { status: 'failed', code: 'BACKPRESSURE' }
      const now = this.env.now(),
        id = this.env.id()
      const receipt: Receipt = { status: 'rejected', code: 'UNSUPPORTED_INPUT' }
      s.inbox.set(id, {
        id,
        connectionId,
        eventId: envelope.externalEventId,
        digest,
        rejectionKind: envelope.kind,
        receipt,
        state: 'rejected',
        error: receipt.code,
        receivedAt: now,
        expiresAt: now,
        scopeKey: '',
        control: false
      })
      if (cursor !== undefined) {
        connection.cursor = cursor
        connection.cursorVersion++
      }
      return receipt
    })
  }
  cancel(bindingId: string, scopeKey: string, requestId?: string): string[] {
    return this.repository.transaction((s) => {
      if (!activeBinding(s, bindingId)) throw new CommunicationError('OWNER_MISMATCH')
      const targets = [...s.inbox.values()].filter(
        (i) =>
          i.bindingId === bindingId &&
          i.scopeKey === scopeKey &&
          (!requestId || i.receipt.requestId === requestId) &&
          !i.control &&
          ['queued', 'dispatching', 'running'].includes(i.state)
      )
      if (requestId && !targets.length) throw new CommunicationError('OWNER_MISMATCH')
      const active: string[] = []
      for (const i of targets) {
        if (i.state !== 'queued') active.push(i.receipt.requestId!)
        else {
          i.state = 'cancelled'
          this.outbox.enqueue(s, i, message('cancelled', i.languages!.uiLanguage))
        }
      }
      return active
    })
  }
}
