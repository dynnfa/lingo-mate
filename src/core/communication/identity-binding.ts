import {
  capabilitySchema,
  CommunicationError,
  LIMITS,
  type Capability
} from './communication-contract'
import {
  activeBinding,
  type Binding,
  type CommunicationRepository,
  type CommunicationState
} from './communication-repository'
import type { CommunicationEnvironment } from './environment'
export class IdentityBinding {
  constructor(
    private readonly repository: CommunicationRepository,
    private readonly env: CommunicationEnvironment
  ) {}
  createChallenge(
    connectionId: string,
    capabilities: Capability[]
  ): { challengeId: string; code: string; expiresAt: number } {
    if (!capabilities.length || capabilities.length > 2)
      throw new CommunicationError('CAPABILITY_DENIED')
    capabilities.forEach((value) => capabilitySchema.parse(value))
    const code = this.env.secret()
    return this.repository.transaction((s) => {
      if (!s.connections.get(connectionId)?.enabled) throw new CommunicationError('NOT_FOUND')
      for (const c of s.challenges.values()) if (c.connectionId === connectionId) c.consumed = true
      const id = this.env.id(),
        expiresAt = this.env.now() + LIMITS.challengeMs
      s.challenges.set(id, {
        id,
        connectionId,
        digest: this.env.digest(code),
        capabilities: [...new Set(capabilities)],
        expiresAt,
        attempts: 0,
        consumed: false
      })
      return { challengeId: id, code, expiresAt }
    })
  }
  submit(
    s: CommunicationState,
    connectionId: string,
    actor: string,
    code: string,
    displayName?: string
  ): boolean {
    const challenges = [...s.challenges.values()].filter(
      (c) =>
        c.connectionId === connectionId &&
        !c.consumed &&
        c.expiresAt > this.env.now() &&
        c.attempts < LIMITS.challengeAttempts
    )
    for (const c of challenges) c.attempts++
    const challenge = challenges.find((c) => c.digest === this.env.digest(code) && !c.actor)
    if (!challenge) return false
    challenge.actor = actor
    challenge.displayName = displayName
    return true
  }
  confirm(challengeId: string): Binding {
    return this.repository.transaction((s) => {
      const c = s.challenges.get(challengeId)
      if (
        !c ||
        !s.connections.get(c.connectionId)?.enabled ||
        c.consumed ||
        !c.actor ||
        c.expiresAt <= this.env.now() ||
        c.attempts > LIMITS.challengeAttempts
      )
        throw new CommunicationError('CHALLENGE_INVALID')
      if (
        [...s.bindings.values()].some(
          (b) => !b.revoked && b.connectionId === c.connectionId && b.externalActorId === c.actor
        )
      )
        throw new CommunicationError('ALREADY_BOUND')
      c.consumed = true
      const binding: Binding = {
        id: this.env.id(),
        connectionId: c.connectionId,
        externalActorId: c.actor,
        principalId: 'local-user',
        version: 1,
        capabilities: [...c.capabilities],
        revoked: false
      }
      s.bindings.set(binding.id, binding)
      return binding
    })
  }
  issueConfirmation(input: {
    bindingId: string
    sessionRef: string
    eventId: string
    operation: string
    parameterDigest: string
  }): string {
    if (
      !input.operation.length ||
      input.operation.length > 64 ||
      !input.parameterDigest.length ||
      input.parameterDigest.length > 128
    )
      throw new CommunicationError('INVALID_INPUT')
    const token = this.env.secret()
    this.repository.transaction((s) => {
      const binding = activeBinding(s, input.bindingId),
        session = s.sessions.get(input.sessionRef)
      if (
        !binding ||
        !session ||
        session.bindingId !== binding.id ||
        session.bindingVersion !== binding.version ||
        !session.active
      )
        throw new CommunicationError('OWNER_MISMATCH')
      const id = this.env.id()
      s.confirmations.set(id, {
        ...input,
        id,
        principalId: binding.principalId,
        bindingVersion: binding.version,
        digest: this.env.digest(token),
        consumed: false,
        expiresAt: this.env.now() + LIMITS.confirmationMs
      })
    })
    return token
  }
  consumeConfirmation(
    token: string,
    input: {
      bindingId: string
      sessionRef: string
      eventId: string
      operation: string
      parameterDigest: string
    }
  ): void {
    this.repository.transaction((s) => this.consume(s, token, input))
  }
  consume(
    s: CommunicationState,
    token: string,
    input: {
      bindingId: string
      sessionRef: string
      eventId: string
      operation: string
      parameterDigest: string
    }
  ): void {
    const binding = activeBinding(s, input.bindingId),
      session = s.sessions.get(input.sessionRef)
    const ticket = [...s.confirmations.values()].find((c) => c.digest === this.env.digest(token))
    if (
      !binding ||
      !session?.active ||
      session.bindingId !== binding.id ||
      !ticket ||
      ticket.consumed ||
      ticket.expiresAt <= this.env.now() ||
      ticket.bindingId !== binding.id ||
      ticket.principalId !== binding.principalId ||
      ticket.bindingVersion !== binding.version ||
      ticket.sessionRef !== input.sessionRef ||
      ticket.operation !== input.operation ||
      ticket.parameterDigest !== input.parameterDigest ||
      ticket.eventId !== input.eventId
    )
      throw new CommunicationError('CONFIRMATION_INVALID')
    ticket.consumed = true
  }
}
