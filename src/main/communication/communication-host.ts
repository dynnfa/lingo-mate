import { randomBytes, randomUUID, createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { CommunicationService } from '../../core/communication/communication-service'
import {
  CommunicationError,
  LIMITS,
  type Languages
} from '../../core/communication/communication-contract'
import type { CommunicationAdapter } from '../../core/communication/communication-adapter'
import type { CommunicationEnvironment } from '../../core/communication/environment'
import { SqliteCommunicationRepository } from '../../database/sqlite-communication-repository'
import {
  communicationSnapshotSchema,
  communicationErrorCodeSchema,
  createQqInputSchema,
  telegramTokenSchema,
  type CommunicationSnapshot
} from '../../shared/communication'
import type { ConversationModule } from '../../core/conversation/conversation-module'
import type { SqliteConversationRepository } from '../../database/sqlite-conversation-repository'
import { ConversationBusinessPort } from './conversation-business-port'
import type { CommunicationCredentialStore } from './credential-store'

export interface AdapterRegistration {
  adapterId: string
  startAsHelp?: boolean
  sessionCursor?: boolean
  verifyQqCredential?(appId: string, secret: string, signal: AbortSignal): Promise<void>
  verifyCredential?(
    credential: string,
    signal: AbortSignal
  ): Promise<{ botId: string; username: string }>
  // Secrets are read only inside Main and passed directly to the transport factory.
  create(
    config: Readonly<Record<string, string>>,
    credential: string | undefined,
    connectionId: string
  ): CommunicationAdapter
}
export class CommunicationHost {
  readonly service: CommunicationService
  private readonly repository: SqliteCommunicationRepository
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private readonly management = new Map<string | undefined, Promise<void>>()
  private readonly controller = new AbortController()
  constructor(
    database: Database.Database,
    conversations: ConversationModule,
    conversationRepository: SqliteConversationRepository,
    private readonly credentials: CommunicationCredentialStore,
    languages: () => Languages,
    private readonly diagnostics: CommunicationEnvironment['diagnostics'],
    private readonly registrations: readonly AdapterRegistration[] = []
  ) {
    this.repository = new SqliteCommunicationRepository(database)
    this.service = new CommunicationService(
      this.repository,
      new ConversationBusinessPort(conversations, conversationRepository),
      {
        now: Date.now,
        id: randomUUID,
        secret: () => randomBytes(16).toString('hex'),
        digest: (value) => createHash('sha256').update(value).digest('hex'),
        languages,
        diagnostics
      }
    )
    for (const registration of registrations)
      this.service.registerAdapter(
        registration.adapterId,
        (id) => {
          const connection = this.repository.read((s) => s.connections.get(id)!)
          return registration.create(
            connection.config,
            connection.credentialRef ? credentials.read(connection.credentialRef) : undefined,
            id
          )
        },
        { startAsHelp: registration.startAsHelp, sessionCursor: registration.sessionCursor }
      )
  }
  async initialize(): Promise<void> {
    await this.service.recover()
    if (this.closed) return
    this.service.cleanup()
    this.credentials.prune?.(
      this.repository.read((s) =>
        [...s.connections.values()].flatMap((c) => (c.credentialRef ? [c.credentialRef] : []))
      )
    )
    // Connections the user explicitly started are resumed after restart without
    // blocking app startup; saved inbox/outbox resume on start.
    for (const id of this.repository.read((s) =>
      [...s.connections.values()].filter((c) => c.enabled && c.autoStart).map((c) => c.id)
    ))
      void this.start(id).catch(() =>
        this.diagnostics({ code: 'COMMUNICATION_AUTOSTART_FAILED', connectionId: id })
      )
    let ticks = 0
    this.timer = setInterval(() => {
      void this.service.flush().catch(() => this.diagnostics({ code: 'COMMUNICATION_TICK_FAILED' }))
      if (++ticks % 240 === 0) {
        try {
          this.service.cleanup()
        } catch {
          this.diagnostics({ code: 'COMMUNICATION_CLEANUP_FAILED' })
        }
      }
    }, 250)
    this.timer.unref()
  }
  snapshot(): CommunicationSnapshot {
    return communicationSnapshotSchema.parse(
      this.repository.read((s) => ({
        installedAdapters: this.registrations.flatMap((r): ('telegram' | 'qq')[] => {
          if (r.adapterId === 'telegram' && r.verifyCredential) return ['telegram']
          if (r.adapterId === 'qq' && r.verifyQqCredential) return ['qq']
          return []
        }),
        connections: [...s.connections.values()]
          .filter((c) => c.enabled || c.state !== 'stopped' || !!c.credentialRef)
          .map((c) => {
            const challenge = c.enabled
              ? [...s.challenges.values()].find(
                  (item) =>
                    item.connectionId === c.id &&
                    !item.consumed &&
                    item.expiresAt > Date.now() &&
                    (item.attempts < LIMITS.challengeAttempts ||
                      (!!item.actor && item.attempts === LIMITS.challengeAttempts))
                )
              : undefined
            const bindings = [...s.bindings.values()].filter(
              (binding) => binding.connectionId === c.id && !binding.revoked
            )
            return {
              id: c.id,
              adapterId: c.adapterId,
              username: c.adapterId === 'telegram' ? c.config.username : undefined,
              createdAt: c.createdAt,
              started: c.state !== 'stopped' && c.state !== 'error',
              autoStart: c.autoStart || undefined,
              deleting: !c.enabled || undefined,
              bindingCount: bindings.length,
              ...(c.adapterId === 'qq'
                ? {
                    appId: c.config.appId,
                    state: c.state,
                    credentialSaved: !!c.credentialRef,
                    errorCode:
                      c.state === 'error' || c.state === 'reconnecting'
                        ? (communicationErrorCodeSchema.safeParse(c.error).data ??
                          'CONNECTION_FAILED')
                        : undefined,
                    bindings: bindings.map((binding) => ({
                      bindingId: binding.id,
                      openId: binding.externalActorId
                    }))
                  }
                : {}),
              bindingChallenge: challenge
                ? {
                    challengeId: challenge.id,
                    expiresAt: challenge.expiresAt,
                    externalActorId: challenge.actor,
                    displayName: challenge.displayName
                  }
                : undefined
            }
          })
      }))
    )
  }
  private coordinate<T>(connectionId: string | undefined, operation: () => Promise<T>): Promise<T> {
    // New connections share a queue for duplicate identity checks.
    const previous = this.management.get(connectionId) ?? Promise.resolve()
    const result = previous.then(() => {
      if (this.closed) throw new CommunicationError('STOPPED')
      return operation()
    })
    const release = (): void => {
      if (this.management.get(connectionId) === settled) this.management.delete(connectionId)
    }
    const settled = result.then(release, release)
    this.management.set(connectionId, settled)
    return result
  }
  start(id: string): Promise<void> {
    return this.coordinate(id, async () => {
      const code = await this.service.start(id)
      if (code !== undefined) throw new CommunicationError(code)
    })
  }
  stop(id: string): Promise<void> {
    return this.coordinate(id, () => this.service.stop(id))
  }
  private async verifyTelegram(token: string): Promise<{ botId: string; username: string }> {
    if (!telegramTokenSchema.safeParse(token).success) throw new CommunicationError('INVALID_INPUT')
    const registration = this.registrations.find((r) => r.adapterId === 'telegram')
    if (!registration?.verifyCredential) throw new CommunicationError('UNKNOWN_ADAPTER')
    const identity = await registration.verifyCredential(token, this.controller.signal)
    this.controller.signal.throwIfAborted()
    if (!/^[1-9][0-9]*$/u.test(identity.botId) || !/^[A-Za-z0-9_]{5,32}$/u.test(identity.username))
      throw new CommunicationError('TELEGRAM_INVALID_RESPONSE')
    return identity
  }
  createTelegramConnection(token: string): Promise<string> {
    return this.coordinate(undefined, async () => {
      const identity = await this.verifyTelegram(token)
      if (
        this.repository.read((s) =>
          [...s.connections.values()].some(
            (c) =>
              c.adapterId === 'telegram' &&
              c.config.botId === identity.botId &&
              (c.enabled || c.state !== 'stopped')
          )
        )
      )
        throw new CommunicationError('TELEGRAM_DUPLICATE_BOT')
      const reference = this.credentials.write(token)
      try {
        return this.service.addConnection('telegram', identity, reference)
      } catch (error) {
        this.credentials.remove(reference)
        throw error
      }
    })
  }
  private async verifyQq(appId: string, appSecret: string): Promise<void> {
    if (!createQqInputSchema.safeParse({ appId, appSecret }).success)
      throw new CommunicationError('INVALID_INPUT')
    const registration = this.registrations.find((r) => r.adapterId === 'qq')
    if (!registration?.verifyQqCredential) throw new CommunicationError('UNKNOWN_ADAPTER')
    await registration.verifyQqCredential(appId, appSecret, this.controller.signal)
    this.controller.signal.throwIfAborted()
  }
  createQqConnection(appId: string, appSecret: string): Promise<string> {
    return this.coordinate(undefined, async () => {
      if (
        this.repository.read((s) =>
          [...s.connections.values()].some(
            (c) =>
              c.adapterId === 'qq' &&
              c.config.appId === appId &&
              (c.enabled || c.state !== 'stopped')
          )
        )
      )
        throw new CommunicationError('QQ_DUPLICATE_APP')
      await this.verifyQq(appId, appSecret)
      const reference = this.credentials.write(appSecret)
      try {
        return this.service.addConnection('qq', { appId }, reference)
      } catch (error) {
        this.credentials.remove(reference)
        throw error
      }
    })
  }
  replaceQqSecret(connectionId: string, appSecret: string): Promise<void> {
    return this.coordinate(connectionId, async () => {
      const connection = this.repository.read((s) => s.connections.get(connectionId))
      if (!connection?.enabled || connection.adapterId !== 'qq')
        throw new CommunicationError('NOT_FOUND')
      await this.service.stop(connectionId)
      this.controller.signal.throwIfAborted()
      await this.verifyQq(connection.config.appId, appSecret)
      this.saveCredential(connectionId, appSecret, connection.credentialRef)
    })
  }
  testConnection(connectionId: string): Promise<void> {
    return this.coordinate(connectionId, async () => {
      const connection = this.repository.read((s) => s.connections.get(connectionId))
      if (!connection?.enabled) throw new CommunicationError('NOT_FOUND')
      if (connection.adapterId === 'qq') {
        if (!connection.credentialRef) throw new CommunicationError('QQ_UNAUTHORIZED')
        await this.verifyQq(
          connection.config.appId,
          this.credentials.read(connection.credentialRef)
        )
        return
      }
      if (connection.adapterId !== 'telegram') throw new CommunicationError('UNKNOWN_ADAPTER')
      if (!connection.credentialRef) throw new CommunicationError('TELEGRAM_UNAUTHORIZED')
      const identity = await this.verifyTelegram(this.credentials.read(connection.credentialRef))
      if (identity.botId !== connection.config.botId)
        throw new CommunicationError('TELEGRAM_BOT_MISMATCH')
    })
  }
  setCredential(connectionId: string, secret: string): Promise<void> {
    return this.coordinate(connectionId, async () => {
      const connection = this.repository.read((s) => s.connections.get(connectionId))
      if (!connection?.enabled || connection.adapterId === 'qq')
        throw new CommunicationError('NOT_FOUND')
      await this.service.stop(connectionId)
      this.controller.signal.throwIfAborted()
      const identity =
        connection.adapterId === 'telegram' ? await this.verifyTelegram(secret) : undefined
      if (identity && identity.botId !== connection.config.botId)
        throw new CommunicationError('TELEGRAM_BOT_MISMATCH')
      this.saveCredential(connectionId, secret, connection.credentialRef, identity?.username)
    })
  }
  private saveCredential(
    connectionId: string,
    secret: string,
    previous?: string,
    username?: string
  ): void {
    const reference = this.credentials.write(secret)
    try {
      this.repository.transaction((s) => {
        const c = s.connections.get(connectionId)!
        c.credentialRef = reference
        if (username) c.config.username = username
      })
    } catch (error) {
      this.credentials.remove(reference)
      throw error
    }
    if (previous) this.credentials.remove(previous)
  }
  deleteConnection(connectionId: string): Promise<void> {
    return this.coordinate(connectionId, async () => {
      const connection = this.repository.read((s) => s.connections.get(connectionId))
      if (!connection) throw new CommunicationError('NOT_FOUND')
      await this.service.deleteConnection(connectionId)
      this.controller.signal.throwIfAborted()
      if (connection.credentialRef) {
        this.credentials.remove(connection.credentialRef)
        this.repository.transaction((s) => {
          s.connections.get(connectionId)!.credentialRef = undefined
        })
      }
    })
  }
  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.controller.abort()
    clearInterval(this.timer)
    await this.service.shutdown()
    this.repository.close()
  }
}
