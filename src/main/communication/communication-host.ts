import { randomBytes, randomUUID, createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { CommunicationService } from '../../core/communication/communication-service'
import { CommunicationError, type Languages } from '../../core/communication/communication-contract'
import type { CommunicationAdapter } from '../../core/communication/communication-adapter'
import type { CommunicationEnvironment } from '../../core/communication/environment'
import { SqliteCommunicationRepository } from '../../database/sqlite-communication-repository'
import { communicationSnapshotSchema, type CommunicationSnapshot } from '../../shared/communication'
import type { ConversationModule } from '../../core/conversation/conversation-module'
import type { SqliteConversationRepository } from '../../database/sqlite-conversation-repository'
import { ConversationBusinessPort } from './conversation-business-port'
import type { CommunicationCredentialStore } from './credential-store'

export interface AdapterRegistration {
  adapterId: string
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
  constructor(
    database: Database.Database,
    conversations: ConversationModule,
    conversationRepository: SqliteConversationRepository,
    private readonly credentials: CommunicationCredentialStore,
    languages: () => Languages,
    private readonly diagnostics: CommunicationEnvironment['diagnostics'],
    registrations: readonly AdapterRegistration[] = []
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
      this.service.registerAdapter(registration.adapterId, (id) => {
        const connection = this.repository.read((s) => s.connections.get(id)!)
        return registration.create(
          connection.config,
          connection.credentialRef ? credentials.read(connection.credentialRef) : undefined
        )
      })
  }
  async initialize(): Promise<void> {
    await this.service.recover()
    if (this.closed) return
    this.service.cleanup()
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
        receipts: [...s.inbox.values()]
          .slice(-50)
          .reverse()
          .map((i) => ({ id: i.id, connectionId: i.connectionId, state: i.state, code: i.error })),
        connections: [...s.connections.values()]
          .filter((c) => c.enabled)
          .map((c) => ({
            id: c.id,
            adapterId: c.adapterId,
            state: c.state,
            hasCredential: !!c.credentialRef
          })),
        challenges: [...s.challenges.values()]
          .filter((c) => !c.consumed && c.actor && c.expiresAt > Date.now())
          .map((c) => ({
            id: c.id,
            connectionId: c.connectionId,
            actor: c.actor!,
            expiresAt: c.expiresAt
          })),
        bindings: [...s.bindings.values()]
          .filter((b) => !b.revoked)
          .slice(-256)
          .map((b) => ({
            id: b.id,
            connectionId: b.connectionId,
            externalActorId: b.externalActorId,
            capabilities: b.capabilities
          })),
        requests: [...s.inbox.values()]
          .filter((i) => i.bindingId && i.receipt.requestId)
          .slice(-50)
          .reverse()
          .map((i) => ({
            requestId: i.receipt.requestId!,
            bindingId: i.bindingId!,
            state: i.state
          })),
        deliveries: [...s.outbox.values()]
          .slice(-50)
          .reverse()
          .map((d) => ({ id: d.id, connectionId: d.connectionId, state: d.state }))
      }))
    )
  }
  async setCredential(connectionId: string, secret: string): Promise<void> {
    const connection = this.repository.read((s) => s.connections.get(connectionId))
    if (!connection) throw new CommunicationError('NOT_FOUND')
    await this.service.stop(connectionId)
    const reference = this.credentials.write(secret)
    try {
      this.repository.transaction((s) => {
        s.connections.get(connectionId)!.credentialRef = reference
      })
    } catch (error) {
      this.credentials.remove(reference)
      throw error
    }
    if (connection.credentialRef) this.credentials.remove(connection.credentialRef)
  }
  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    await this.service.shutdown()
    this.repository.close()
  }
}
