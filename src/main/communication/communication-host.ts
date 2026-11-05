import { randomBytes, randomUUID, createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { CommunicationService } from '../../core/communication/communication-service'
import { CommunicationError, type Languages } from '../../core/communication/communication-contract'
import type { CommunicationAdapter } from '../../core/communication/communication-adapter'
import type { CommunicationEnvironment } from '../../core/communication/environment'
import { SqliteCommunicationRepository } from '../../database/sqlite-communication-repository'
import {
  communicationSnapshotSchema,
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
  verifyCredential?(
    credential: string,
    signal: AbortSignal
  ): Promise<{ botId: string; username: string }>
  // Secrets are read only inside Main and passed directly to the transport factory.
  create(
    config: Readonly<Record<string, string>>,
    credential: string | undefined
  ): CommunicationAdapter
}
export class CommunicationHost {
  readonly service: CommunicationService
  private readonly repository: SqliteCommunicationRepository
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private management: Promise<void> = Promise.resolve()
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
            connection.credentialRef ? credentials.read(connection.credentialRef) : undefined
          )
        },
        { startAsHelp: registration.startAsHelp }
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
    // Explicit start is required after restart; saved inbox/outbox resume on start.
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
        installedAdapters: this.registrations.some(
          (r) => r.adapterId === 'telegram' && r.verifyCredential
        )
          ? ['telegram']
          : [],
        connections: [...s.connections.values()]
          .filter((c) => c.enabled || c.state !== 'stopped' || !!c.credentialRef)
          .map((c) => ({
            id: c.id,
            adapterId: c.adapterId,
            username: c.adapterId === 'telegram' ? c.config.username : undefined,
            createdAt: c.createdAt,
            deleting: !c.enabled || undefined
          }))
      }))
    )
  }
  private coordinate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.management.then(() => {
      if (this.closed) throw new CommunicationError('STOPPED')
      return operation()
    })
    this.management = result.then(
      () => {},
      () => {}
    )
    return result
  }
  start(id: string): Promise<void> {
    return this.coordinate(() => this.service.start(id))
  }
  stop(id: string): Promise<void> {
    return this.coordinate(() => this.service.stop(id))
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
    return this.coordinate(async () => {
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
  testConnection(connectionId: string): Promise<void> {
    return this.coordinate(async () => {
      const connection = this.repository.read((s) => s.connections.get(connectionId))
      if (!connection?.enabled) throw new CommunicationError('NOT_FOUND')
      if (connection.adapterId !== 'telegram') throw new CommunicationError('UNKNOWN_ADAPTER')
      if (!connection.credentialRef) throw new CommunicationError('TELEGRAM_UNAUTHORIZED')
      const identity = await this.verifyTelegram(this.credentials.read(connection.credentialRef))
      if (identity.botId !== connection.config.botId)
        throw new CommunicationError('TELEGRAM_BOT_MISMATCH')
    })
  }
  setCredential(connectionId: string, secret: string): Promise<void> {
    return this.coordinate(async () => {
      const connection = this.repository.read((s) => s.connections.get(connectionId))
      if (!connection?.enabled) throw new CommunicationError('NOT_FOUND')
      await this.service.stop(connectionId)
      this.controller.signal.throwIfAborted()
      const identity =
        connection.adapterId === 'telegram' ? await this.verifyTelegram(secret) : undefined
      if (identity && identity.botId !== connection.config.botId)
        throw new CommunicationError('TELEGRAM_BOT_MISMATCH')
      const reference = this.credentials.write(secret)
      try {
        this.repository.transaction((s) => {
          const c = s.connections.get(connectionId)!
          c.credentialRef = reference
          if (identity) c.config.username = identity.username
        })
      } catch (error) {
        this.credentials.remove(reference)
        throw error
      }
      if (connection.credentialRef) this.credentials.remove(connection.credentialRef)
    })
  }
  deleteConnection(connectionId: string): Promise<void> {
    return this.coordinate(async () => {
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
