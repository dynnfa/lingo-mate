import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ChatChannelsService, ChatChannelsServiceError } from '../chat-channels-service'
import { TelegramApiClient, TelegramApiError } from '../channels/telegram-api'
import { memoryChannelStore } from '../../core/channels/__tests__/fixtures'
import type { ChatChannelCredentialStore } from '../chat-channel-credential-store'
import type { CredentialVault } from '../../core/llm/model-config'
import type { CoreDiagnostics } from '../../core/error-diagnostics'

// 服务层测试：假 API 客户端与假凭据库，不触达网络与 Electron。

const noopDiagnostics: CoreDiagnostics = { report: () => {} }

function fakeVault(): CredentialVault {
  return {
    isAvailable: () => true,
    encrypt: (plain: string) => `enc:${plain}`,
    decrypt: (serialized: string) => serialized.replace(/^enc:/, '')
  }
}

function memoryCredentialStore(): ChatChannelCredentialStore & { record?: unknown } {
  let saved: unknown
  return {
    get record() {
      return saved
    },
    read() {
      return saved as never
    },
    write(record) {
      saved = record
    },
    clear() {
      saved = null
    }
  }
}

function apiClientReturning(identity: { id: string; username: string | null }): {
  getMe: ReturnType<typeof vi.fn>
  getWebhookInfo: ReturnType<typeof vi.fn>
  getUpdates: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
} {
  return {
    getMe: vi.fn(async () => identity),
    getWebhookInfo: vi.fn(async () => ({ url: null })),
    getUpdates: vi.fn(async () => []),
    sendMessage: vi.fn(async () => {})
  }
}

interface ModuleStub {
  handleInbound: ReturnType<typeof vi.fn>
  noteIgnored: ReturnType<typeof vi.fn>
  deliverPendingReplies: ReturnType<typeof vi.fn>
  recover: ReturnType<typeof vi.fn>
  pauseConnection: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  issueBindingCode: ReturnType<typeof vi.fn>
  confirmPendingBinding: ReturnType<typeof vi.fn>
  rejectPendingBinding: ReturnType<typeof vi.fn>
  unbind: ReturnType<typeof vi.fn>
}

interface ServiceHarness {
  store: ReturnType<typeof memoryChannelStore>
  credentialStore: ChatChannelCredentialStore & { record?: unknown }
  states: Array<[string, string | undefined]>
  client: ReturnType<typeof apiClientReturning>
  module: ModuleStub
  service: ChatChannelsService
}

function buildServiceModuleStub(): ModuleStub {
  return {
    handleInbound: vi.fn(async () => {}),
    noteIgnored: vi.fn(),
    deliverPendingReplies: vi.fn(async () => {}),
    recover: vi.fn(async () => {}),
    pauseConnection: vi.fn(),
    dispose: vi.fn(),
    issueBindingCode: vi.fn(async () => ({
      code: 'AB23CD',
      expiresAt: '2026-09-23T12:10:00.000Z'
    })),
    confirmPendingBinding: vi.fn(async () => ({
      bindingId: randomUUID(),
      connectionId: 'conn',
      platform: 'telegram',
      senderId: '7000000001',
      chatId: '8000000001',
      displayName: 'Leon',
      status: 'active',
      requestedAt: '2026-09-23T11:58:00.000Z',
      confirmedAt: '2026-09-23T11:59:00.000Z',
      unboundAt: null
    })),
    rejectPendingBinding: vi.fn(),
    unbind: vi.fn(async () => {})
  }
}

function buildService(
  options: {
    identity?: { id: string; username: string | null }
    states?: Array<[string, string | undefined]>
    replyRetryIntervalMs?: number
  } = {}
): ServiceHarness {
  const store = memoryChannelStore()
  const credentialStore = memoryCredentialStore()
  const states: Array<[string, string | undefined]> = options.states ?? []
  const client = apiClientReturning(options.identity ?? { id: '6000000001', username: 'bot' })
  const module = buildServiceModuleStub()
  const service = new ChatChannelsService({
    store,
    module: module as never,
    credentialStore,
    vault: fakeVault(),
    createClient: undefined as never,
    createApiClient: () => client as unknown as TelegramApiClient,
    onStateChanged: (state, errorCode) => states.push([state, errorCode]),
    diagnostics: noopDiagnostics,
    replyRetryIntervalMs: options.replyRetryIntervalMs
  } as never)
  return { store, credentialStore, states, client, module, service }
}

describe('ChatChannelsService', () => {
  it('resumes reply retries after an offline startup without creating another poller', async () => {
    vi.useFakeTimers()
    const { service, client, module } = buildService({ replyRetryIntervalMs: 10 })
    client.getWebhookInfo.mockRejectedValueOnce(new TelegramApiError('NETWORK', 'offline'))
    try {
      await service.configureConnection('123:TOKEN')
      expect(service.getStatus().connection?.state).toBe('error')
      await expect(service.connect()).rejects.toMatchObject({ code: 'ALREADY_CONNECTED' })
      await vi.advanceTimersByTimeAsync(1010)
      expect(service.getStatus().connection?.state).toBe('connected')
      expect(module.deliverPendingReplies).toHaveBeenCalled()
      expect(client.getWebhookInfo).toHaveBeenCalledTimes(2)
    } finally {
      service.dispose()
      vi.useRealTimers()
    }
  })

  it('returns the binding rejection operation to its caller', async () => {
    const { service, module } = buildService()
    const result = service.rejectPendingBinding()
    expect(result).toBeInstanceOf(Promise)
    await result
    expect(module.rejectPendingBinding).toHaveBeenCalledOnce()
  })

  it('retries pending replies while connected and stops retrying after disconnect', async () => {
    const { service, module } = buildService({ replyRetryIntervalMs: 10 })
    await service.configureConnection('123:TOKEN')
    await vi.waitFor(() =>
      expect(module.deliverPendingReplies.mock.calls.length).toBeGreaterThan(1)
    )
    await service.disconnect()
    const calls = module.deliverPendingReplies.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(module.deliverPendingReplies.mock.calls.length).toBe(calls)
  })

  it('configures a connection, stores the token encrypted and connects', async () => {
    const { service, credentialStore, states, store } = buildService()
    const connection = await service.configureConnection('123:TOKEN')

    expect(connection).toMatchObject({
      botId: '6000000001',
      botUsername: 'bot',
      state: 'connected'
    })
    expect(credentialStore.read()).toMatchObject({
      schemaVersion: 1,
      encryptedToken: 'enc:123:TOKEN'
    })
    expect(states).toContainEqual(['connected', undefined])
    expect(store.findSoleConnection()).toMatchObject({ botId: '6000000001' })
  })

  it('rejects invalid tokens without storing anything', async () => {
    const failing = apiClientReturning({ id: '6000000001', username: null })
    ;(failing.getMe as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TelegramApiError('UNAUTHORIZED', 'unauthorized', 401)
    )
    void failing
    const built = buildService()
    const broken = new ChatChannelsService({
      store: built.store,
      module: built.module as never,
      credentialStore: built.credentialStore,
      vault: fakeVault(),
      createApiClient: () =>
        ({
          getMe: async () => {
            throw new TelegramApiError('UNAUTHORIZED', 'unauthorized', 401)
          }
        }) as unknown as TelegramApiClient,
      onStateChanged: () => {},
      diagnostics: noopDiagnostics
    } as never)
    await expect(broken.configureConnection('bad-token')).rejects.toMatchObject({
      code: 'TOKEN_INVALID'
    })
    expect(built.credentialStore.read()).toBeUndefined()
  })

  it('refuses to store credentials when secure storage is unavailable', async () => {
    const built = buildService()
    const service = new ChatChannelsService({
      store: built.store,
      module: built.module as never,
      credentialStore: built.credentialStore,
      vault: {
        isAvailable: () => false,
        encrypt: () => '',
        decrypt: () => ''
      },
      createApiClient: built.service
        ? built.service['deps']['createApiClient']
        : () => built.client as never,
      onStateChanged: () => {},
      diagnostics: noopDiagnostics
    } as never)
    await expect(service.configureConnection('123:TOKEN')).rejects.toMatchObject({
      code: 'CREDENTIAL_STORAGE_UNAVAILABLE'
    })
  })

  it('replaces channel state when the bot changes', async () => {
    const { service, store, module } = buildService()
    await service.configureConnection('123:TOKEN')
    const firstConnectionId = store.findSoleConnection()!.connectionId
    store.saveCursor(firstConnectionId, 77, '2026-09-23T12:00:00.000Z')

    const rebuilt = buildService({ identity: { id: '6000000002', username: 'other' } })
    // 复用同一 store：模拟更换 Bot。
    const second = new ChatChannelsService({
      store,
      module: module as never,
      credentialStore: rebuilt.credentialStore,
      vault: fakeVault(),
      createApiClient: () => rebuilt.client as unknown as TelegramApiClient,
      onStateChanged: () => {},
      diagnostics: noopDiagnostics
    } as never)
    await second.configureConnection('999:TOKEN')

    const connection = store.findSoleConnection()!
    expect(connection.botId).toBe('6000000002')
    expect(connection.connectionId).toBe(firstConnectionId)
    // 旧游标被清空，禁止沿用。
    expect(store.getCursor(firstConnectionId)).toBeNull()
  })

  it('disconnect cancels tasks and reports states; status composes views', async () => {
    const { service, module, states } = buildService()
    await service.configureConnection('123:TOKEN')
    await service.disconnect()

    expect(module.pauseConnection).toHaveBeenCalled()
    expect(states.at(-1)).toEqual(['disconnected', undefined])
    const status = service.getStatus()
    expect(status.connection).toMatchObject({ state: 'disconnected', botId: '6000000001' })
    expect(status.binding).toBeNull()

    await expect(service.disconnect()).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
  })

  it('initializes by recovering state and resuming an existing connection', async () => {
    const { service, module, states } = buildService()
    await service.configureConnection('123:TOKEN')
    const resume = buildService()
    const resuming = new ChatChannelsService({
      store: resume.store,
      module: resume.module as never,
      credentialStore: resume.credentialStore,
      vault: fakeVault(),
      createApiClient: () => resume.client as unknown as TelegramApiClient,
      onStateChanged: (state) => states.push([state, undefined]),
      diagnostics: noopDiagnostics
    } as never)
    void service
    void module
    await resuming.initialize()
    expect(resume.module.recover).toHaveBeenCalled()
    expect(states).toContainEqual(['connected', undefined])
  })

  it('maps channel domain errors to service error codes', async () => {
    const built = buildService()
    const failingModule = {
      ...built.module,
      issueBindingCode: async () => {
        throw new (await import('../../core/channels/channel-errors')).ChannelError('NO_CONNECTION')
      }
    }
    const service = new ChatChannelsService({
      store: built.store,
      module: failingModule as never,
      credentialStore: built.credentialStore,
      vault: fakeVault(),
      createApiClient: () => built.client as unknown as TelegramApiClient,
      onStateChanged: () => {},
      diagnostics: noopDiagnostics
    } as never)
    await expect(service.issueBindingCode()).rejects.toBeInstanceOf(ChatChannelsServiceError)
  })
})
