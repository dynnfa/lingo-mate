import { CommunicationError, LIMITS } from './communication-contract'
import {
  activeBinding,
  type CommunicationRepository,
  type Inbox,
  type Session
} from './communication-repository'
import type { CommunicationEnvironment } from './environment'
import type { BusinessPort } from './business-port'
import { message } from './reply-projection'
export class CommunicationSessions {
  constructor(
    private readonly repository: CommunicationRepository,
    private readonly env: CommunicationEnvironment,
    private readonly business: BusinessPort
  ) {}
  async resolve(inbox: Inbox): Promise<Session> {
    const existing = this.repository.transaction((s) => {
      for (const session of s.sessions.values()) {
        if (session.active && this.env.now() - session.touchedAt >= LIMITS.sessionIdleMs)
          session.active = false
      }
      return [...s.sessions.values()].find(
        (v) =>
          v.active &&
          v.bindingId === inbox.bindingId &&
          v.bindingVersion === inbox.bindingVersion &&
          v.connectionId === inbox.connectionId &&
          v.route.externalConversationId === inbox.event!.externalConversationId &&
          v.route.externalThreadId === inbox.event!.externalThreadId &&
          v.languages.targetLanguage === inbox.languages!.targetLanguage
      )
    })
    if (existing) return existing
    const id = this.env.id(),
      sessionId = this.env.id()
    // Create durably through ConversationModule BEFORE writing a foreign-key mapping.
    // A crash here may leave an empty conversation, never a dangling mapping.
    await this.business.createSession(
      sessionId,
      message('sessionTitle', inbox.languages!.uiLanguage)
    )
    return this.repository.transaction((s) => {
      if (!activeBinding(s, inbox.bindingId, inbox.bindingVersion))
        throw new CommunicationError('OWNER_MISMATCH')
      const event = inbox.event!
      const session: Session = {
        id,
        sessionId,
        bindingId: inbox.bindingId!,
        bindingVersion: inbox.bindingVersion!,
        connectionId: inbox.connectionId,
        route: {
          externalActorId: event.externalActorId,
          externalConversationId: event.externalConversationId,
          externalThreadId: event.externalThreadId
        },
        languages: inbox.languages!,
        active: true,
        touchedAt: this.env.now()
      }
      s.sessions.set(id, session)
      return session
    })
  }
  end(inbox: Inbox): void {
    this.repository.transaction((s) => {
      for (const session of s.sessions.values())
        if (
          session.active &&
          session.bindingId === inbox.bindingId &&
          session.route.externalConversationId === inbox.event!.externalConversationId &&
          session.languages.targetLanguage === inbox.languages!.targetLanguage
        )
          session.active = false
    })
  }
}
