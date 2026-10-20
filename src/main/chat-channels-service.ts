import { randomUUID } from 'node:crypto'
import type { CoreDiagnostics } from '../core/error-diagnostics'
import { ChannelError } from '../core/channels/channel-errors'
import type { ChannelModule } from '../core/channels/channel-module'
import type { ChannelStore } from '../core/channels/channel-store'
import type { ChannelDeliveryOutcome, ChannelTransport } from '../core/channels/channel-types'
import type { CredentialVault } from '../core/llm/model-config'
import type {
  ChatChannelConnectionErrorCode,
  ChatChannelConnectionState,
  ChatChannelConnectionView,
  ChatChannelBindingView,
  ChatChannelPendingBindingRequestView
} from '../shared/chat-channels'
import { TelegramChannelAdapter } from './channels/telegram-adapter'
import { TelegramApiClient, TelegramApiError } from './channels/telegram-api'
import type { ChatChannelCredentialStore } from './chat-channel-credential-store'

// 聊天平台 Main 服务：连接生命周期、凭据管理与状态上报。
// - Token 仅在 Main 安全存储与使用，不回读明文、不写入日志。
// - 同一 Bot 只允许一个轮询实例；更换 Bot 清空旧归属与游标。
// - 断开连接取消运行及排队任务；重连只补发仍授权的已完成结果。

export type ChatChannelsServiceErrorCode =
  | 'NO_CONNECTION'
  | 'NOT_CONNECTED'
  | 'ALREADY_CONNECTED'
  | 'NO_PENDING_BINDING_REQUEST'
  | 'NO_ACTIVE_BINDING'
  | 'CREDENTIAL_STORAGE_UNAVAILABLE'
  | 'TOKEN_INVALID'
  | 'WEBHOOK_CONFLICT'
  | 'DUPLICATE_POLLING'
  | 'CHANNELS_READ_FAILED'
  | 'CHANNELS_WRITE_FAILED'

export class ChatChannelsServiceError extends Error {
  constructor(
    readonly code: ChatChannelsServiceErrorCode,
    cause?: unknown
  ) {
    super(`Chat channels error: ${code}`)
    this.name = 'ChatChannelsServiceError'
    if (cause !== undefined) this.cause = cause
  }
}

export interface ChatChannelsServiceDeps {
  store: ChannelStore
  module: ChannelModule
  credentialStore: ChatChannelCredentialStore
  vault: CredentialVault
  // 适配器工厂注入：测试使用假 API 客户端，不触达真实网络。
  createApiClient: (token: string) => TelegramApiClient
  onStateChanged: (
    state: ChatChannelConnectionState,
    errorCode?: ChatChannelConnectionErrorCode
  ) => void
  diagnostics: CoreDiagnostics
  replyRetryIntervalMs?: number
}

export class ChatChannelsService implements ChannelTransport {
  private adapter: TelegramChannelAdapter | null = null
  private replyRetryTimer: ReturnType<typeof setInterval> | null = null
  private configuring = false
  private connectionState: ChatChannelConnectionState = 'disconnected'
  private connectionErrorCode: ChatChannelConnectionErrorCode | undefined

  constructor(private readonly deps: ChatChannelsServiceDeps) {}

  // 配置连接：校验 Token（getMe）、安全存储凭据；更换 Bot 时重置归属。
  async configureConnection(token: string): Promise<ChatChannelConnectionView> {
    if (this.configuring || this.connectionState === 'connecting')
      throw new ChatChannelsServiceError('ALREADY_CONNECTED')
    this.configuring = true
    try {
      if (!this.deps.vault.isAvailable()) {
        throw new ChatChannelsServiceError('CREDENTIAL_STORAGE_UNAVAILABLE')
      }
      let identity: { id: string; username: string | null }
      try {
        identity = await this.deps.createApiClient(token).getMe()
      } catch (error) {
        if (error instanceof TelegramApiError && error.code === 'UNAUTHORIZED') {
          throw new ChatChannelsServiceError('TOKEN_INVALID', error)
        }
        throw new ChatChannelsServiceError('CHANNELS_WRITE_FAILED', error)
      }
      const now = new Date().toISOString()
      const existing = this.deps.store.findSoleConnection()
      const connection = {
        connectionId: existing?.connectionId ?? randomUUID(),
        platform: 'telegram' as const,
        botId: identity.id,
        botUsername: identity.username,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      this.stopAdapter()
      this.deps.module.pauseConnection()
      if (existing && existing.botId !== connection.botId) {
        // 更换 Bot：重新绑定，禁止沿用旧账号归属、游标或待发回复。
        this.deps.store.replaceConnection(connection)
      } else {
        this.deps.store.saveConnection(connection)
      }
      this.deps.credentialStore.write({
        schemaVersion: 1,
        connectionId: connection.connectionId,
        encryptedToken: this.deps.vault.encrypt(token)
      })
      await this.connectStored()
      return this.toConnectionView({ ...connection, state: this.connectionState })
    } finally {
      this.configuring = false
    }
  }

  async connect(): Promise<void> {
    if (this.configuring) throw new ChatChannelsServiceError('ALREADY_CONNECTED')
    await this.connectStored()
  }

  private async connectStored(): Promise<void> {
    const connection = this.deps.store.findSoleConnection()
    if (!connection) throw new ChatChannelsServiceError('NO_CONNECTION')
    if (
      this.adapter?.isPolling() ||
      this.adapter?.isStarting() ||
      this.connectionState === 'connecting'
    )
      throw new ChatChannelsServiceError('ALREADY_CONNECTED')
    const credential = this.deps.credentialStore.read()
    if (!credential || credential.connectionId !== connection.connectionId) {
      throw new ChatChannelsServiceError('NO_CONNECTION')
    }
    let token: string
    try {
      token = this.deps.vault.decrypt(credential.encryptedToken)
    } catch (error) {
      throw new ChatChannelsServiceError('TOKEN_INVALID', error)
    }
    const api = this.deps.createApiClient(token)
    const adapter = new TelegramChannelAdapter(api, connection.connectionId, connection.botId, {
      onMessage: (message) => this.deps.module.handleInbound(message),
      onIgnored: (event) => this.deps.module.noteIgnored(event),
      commitCursor: (offset) =>
        this.deps.store.saveCursor(connection.connectionId, offset, new Date().toISOString()),
      onStateChanged: (state, errorCode) => this.setState(state, errorCode)
    })
    this.adapter = adapter
    try {
      await adapter.start(this.deps.store.getCursor(connection.connectionId) ?? 0)
    } catch (error) {
      this.adapter = null
      throw error
    }
    if (this.connectionState !== 'connected') return
    // 连接恢复后补发仍授权的待发回复，不重跑任何任务。
    void this.deps.module.deliverPendingReplies().catch((error: unknown) => {
      this.deps.diagnostics.report({
        level: 'warn',
        module: 'chat-channels',
        operation: 'deliver-pending',
        message: 'pending channel replies delivery failed',
        error
      })
    })
  }

  async disconnect(): Promise<void> {
    const connection = this.deps.store.findSoleConnection()
    if (!connection) throw new ChatChannelsServiceError('NO_CONNECTION')
    if (!this.adapter?.isPolling() && this.connectionState === 'disconnected') {
      throw new ChatChannelsServiceError('NOT_CONNECTED')
    }
    this.stopAdapter()
    // 断开连接：取消运行及排队任务，暂停投递。
    this.deps.module.pauseConnection()
  }

  // 应用启动时的恢复入口：核对提交记录、收敛状态后按需重连。
  async initialize(): Promise<void> {
    await this.deps.module.recover()
    const connection = this.deps.store.findSoleConnection()
    if (!connection) return
    const credential = this.deps.credentialStore.read()
    if (!credential || credential.connectionId !== connection.connectionId) return
    await this.connect().catch((error: unknown) => {
      this.deps.diagnostics.report({
        level: 'warn',
        module: 'chat-channels',
        operation: 'initialize-connect',
        message: 'channel connection failed to resume on startup',
        error
      })
    })
  }

  getStatus(): {
    connection: ChatChannelConnectionView | null
    binding: ChatChannelBindingView | null
    pendingBindingRequest: ChatChannelPendingBindingRequestView | null
  } {
    const connection = this.deps.store.findSoleConnection()
    const binding = connection
      ? this.deps.store.findActiveBinding(connection.connectionId)
      : undefined
    const pending = connection
      ? this.deps.store.findPendingBinding(connection.connectionId)
      : undefined
    return {
      connection: connection
        ? this.toConnectionView({
            ...connection,
            state: this.connectionState,
            ...(this.connectionErrorCode ? { errorCode: this.connectionErrorCode } : {})
          })
        : null,
      binding: binding ? this.toBindingView(binding) : null,
      pendingBindingRequest: pending
        ? {
            bindingId: pending.bindingId,
            connectionId: pending.connectionId,
            platform: pending.platform,
            senderId: pending.senderId,
            displayName: pending.displayName,
            requestedAt: pending.requestedAt
          }
        : null
    }
  }

  async issueBindingCode(): Promise<{ code: string; expiresAt: string }> {
    return this.callModule(() => this.deps.module.issueBindingCode())
  }

  async confirmBinding(): Promise<ChatChannelBindingView> {
    const binding = await this.callModule(() => this.deps.module.confirmPendingBinding())
    return this.toBindingView(binding)
  }

  rejectPendingBinding(): Promise<void> {
    return this.callModule(() => {
      this.deps.module.rejectPendingBinding()
      return undefined
    })
  }

  async unbind(): Promise<void> {
    await this.callModule(() => this.deps.module.unbind())
  }

  // 作为渠道出站传输：委托给当前连接的活动适配器；未连接时不投递。
  async send(
    target: Parameters<ChannelTransport['send']>[0],
    text: string
  ): Promise<ChannelDeliveryOutcome> {
    if (!this.adapter?.isPolling()) return { delivered: false, deferred: true }
    return this.adapter.send(target, text)
  }

  dispose(): void {
    this.stopAdapter()
    this.deps.module.dispose()
  }

  private async callModule<T>(operation: () => Promise<T> | T): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ChannelError) throw new ChatChannelsServiceError(error.code)
      throw error
    }
  }

  private stopAdapter(): void {
    if (this.replyRetryTimer) clearInterval(this.replyRetryTimer)
    this.replyRetryTimer = null
    this.adapter?.stop()
    this.adapter = null
    this.setState('disconnected')
  }

  private startReplyRetry(): void {
    if (this.replyRetryTimer) clearInterval(this.replyRetryTimer)
    this.replyRetryTimer = setInterval(() => {
      if (this.connectionState !== 'connected') return
      void this.deps.module.deliverPendingReplies().catch((error: unknown) => {
        this.deps.diagnostics.report({
          level: 'warn',
          module: 'chat-channels',
          operation: 'retry-replies',
          message: 'pending channel reply retry failed',
          error
        })
      })
    }, this.deps.replyRetryIntervalMs ?? 5_000)
    this.replyRetryTimer.unref?.()
  }

  private setState(
    state: ChatChannelConnectionState,
    errorCode?: ChatChannelConnectionErrorCode
  ): void {
    if (state === 'connected' && this.connectionState !== 'connected') this.startReplyRetry()
    this.connectionState = state
    this.connectionErrorCode = errorCode
    this.deps.onStateChanged(state, errorCode)
  }

  private toConnectionView(
    connection: {
      connectionId: string
      platform: 'telegram'
      botId: string
      botUsername: string | null
      createdAt: string
      updatedAt: string
    } & Partial<Pick<ChatChannelConnectionView, 'state' | 'errorCode'>>
  ): ChatChannelConnectionView {
    return {
      connectionId: connection.connectionId,
      platform: connection.platform,
      botId: connection.botId,
      botUsername: connection.botUsername,
      state: connection.state ?? this.connectionState,
      ...((connection.errorCode ?? this.connectionErrorCode)
        ? { errorCode: connection.errorCode ?? this.connectionErrorCode }
        : {}),
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt
    }
  }

  private toBindingView(binding: {
    bindingId: string
    connectionId: string
    platform: 'telegram'
    senderId: string
    displayName: string | null
    confirmedAt: string | null
  }): ChatChannelBindingView {
    return {
      bindingId: binding.bindingId,
      connectionId: binding.connectionId,
      platform: binding.platform,
      senderId: binding.senderId,
      displayName: binding.displayName,
      boundAt: binding.confirmedAt ?? new Date(0).toISOString()
    }
  }
}
