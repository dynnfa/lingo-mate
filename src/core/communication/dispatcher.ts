import { CommunicationError, LIMITS } from './communication-contract'
import { activeBinding, type CommunicationRepository, type Inbox } from './communication-repository'
import type { CommunicationEnvironment } from './environment'
import type { BusinessPort, BusinessResult } from './business-port'
import type { Outbox } from './outbox'
import { CommunicationSessions } from './communication-session'
import { operationFor } from './inbox'
import { schedule } from './timers'
import { message } from './reply-projection'
export class Dispatcher {
  private closed = false
  private readonly active = new Map<string, AbortController>()
  private readonly timers = new Map<string, () => void>()
  private readonly sessions: CommunicationSessions
  constructor(
    private readonly repository: CommunicationRepository,
    private readonly env: CommunicationEnvironment,
    private readonly business: BusinessPort,
    private readonly outbox: Outbox
  ) {
    this.sessions = new CommunicationSessions(repository, env, business)
  }
  async flush(): Promise<void> {
    while (!this.closed) {
      const batch = this.repository.transaction((s) => {
        const scopes = new Set<string>()
        const queue: Inbox[] = []
        for (const i of s.inbox.values()) {
          if (i.state !== 'queued' || scopes.has(i.scopeKey)) continue
          if (s.connections.get(i.connectionId)?.state !== 'online') continue
          if (
            [...s.inbox.values()].some(
              (a) => a.scopeKey === i.scopeKey && ['dispatching', 'running'].includes(a.state)
            )
          )
            continue
          scopes.add(i.scopeKey)
          if (i.expiresAt <= this.env.now() || !activeBinding(s, i.bindingId, i.bindingVersion)) {
            i.state = i.expiresAt <= this.env.now() ? 'expired' : 'rejected'
            this.outbox.enqueue(
              s,
              i,
              message('rejected', i.languages!.uiLanguage, {
                code: i.state === 'expired' ? 'EXPIRED' : 'OWNER_MISMATCH'
              })
            )
            continue
          }
          const operation = i.event?.type === 'text' ? operationFor(i.event.text) : undefined
          if (
            !i.control &&
            (!operation ||
              !activeBinding(s, i.bindingId, i.bindingVersion)!.capabilities.includes(operation))
          ) {
            i.state = 'rejected'
            continue
          }
          i.state = 'dispatching'
          queue.push(i)
          // Bounded ingress concurrency; AgentRuntime and domain locks remain authoritative.
          if (queue.length === 2) break
        }
        return queue
      })
      if (!batch.length) break
      await Promise.all(batch.map((i) => this.execute(i)))
    }
  }
  private async execute(inbox: Inbox): Promise<void> {
    const requestId = inbox.receipt.requestId!
    const controller = new AbortController()
    this.active.set(requestId, controller)
    const cancelTimer = schedule(this.env, () => this.cancel(requestId), LIMITS.operationMs)
    this.timers.set(requestId, cancelTimer)
    let submitted = false
    try {
      const text = inbox.event?.type === 'text' ? inbox.event.text : ''
      if (inbox.control) {
        if (text === '/new') this.sessions.end(inbox)
        else if (text !== '/help') throw new CommunicationError('INVALID_INPUT')
        this.finish(inbox.id, {
          status: 'succeeded',
          text: message(text === '/new' ? 'new' : 'help', inbox.languages!.uiLanguage)
        })
        return
      }
      const session = await this.sessions.resolve(inbox)
      if (this.closed) return
      controller.signal.throwIfAborted()
      const request = this.repository.transaction((s) => {
        const i = s.inbox.get(inbox.id)!
        if (!activeBinding(s, i.bindingId, i.bindingVersion) || i.state !== 'dispatching')
          throw new CommunicationError('OWNER_MISMATCH')
        i.sessionRef = session.id
        session.touchedAt = this.env.now()
        s.sessions.get(session.id)!.touchedAt = session.touchedAt
        i.request = {
          requestId,
          sessionId: session.sessionId,
          userMessageId: this.env.id(),
          assistantMessageId: this.env.id(),
          operation: operationFor(text)!,
          text: operationFor(text) === 'sentence' ? text.replace(/^\/sentence\s+/u, '') : text,
          languages: i.languages!
        }
        i.state = 'running'
        return i.request
      })
      // Every request identity and ownership is now durable. This is the only execute call.
      submitted = true
      const result = await this.business.execute(request, controller.signal)
      if (!this.closed) this.finish(inbox.id, result)
    } catch {
      if (!this.closed) {
        if (submitted && !controller.signal.aborted) {
          // Execution may have committed before the failure. Do not report it as
          // a business failure or attempt a replay; recovery must inspect the domain.
          this.repository.transaction((s) => {
            s.inbox.get(inbox.id)!.state = 'interrupted'
          })
          this.env.diagnostics({ code: 'EXECUTION_INTERRUPTED', requestId })
        } else this.finish(inbox.id, { status: controller.signal.aborted ? 'cancelled' : 'failed' })
      }
    } finally {
      cancelTimer()
      this.timers.delete(requestId)
      this.active.delete(requestId)
    }
  }
  finish(id: string, result: BusinessResult): void {
    this.repository.transaction((s) => {
      const i = s.inbox.get(id)!
      i.state = result.status
      const text =
        result.status === 'succeeded'
          ? result.text
          : message(result.status, i.languages!.uiLanguage)
      this.outbox.enqueue(s, i, text || message('failed', i.languages!.uiLanguage))
    })
  }
  cancel(requestId: string): void {
    this.active.get(requestId)?.abort()
    try {
      this.business.cancel(requestId)
    } catch {
      /* before module registration or after terminal event */
    }
  }
  close(): void {
    this.closed = true
    for (const cancel of this.timers.values()) cancel()
    this.timers.clear()
    for (const id of this.active.keys()) this.cancel(id)
  }
}
