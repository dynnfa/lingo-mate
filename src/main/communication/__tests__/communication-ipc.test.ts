import type { CommunicationCredentialStore } from '../credential-store'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../database/database'
import { SqliteCommunicationRepository } from '../../../database/sqlite-communication-repository'
import { SqliteConversationRepository } from '../../../database/sqlite-conversation-repository'
import { createTestConversationModule } from '../../../../tests/fixtures/conversation'
import { CommunicationHost } from '../communication-host'
import { registerCommunicationIpc } from '../communication-ipc'
import { createTrustedHandlerRegistrar } from '../../ipc-guard'
import { COMMUNICATION_CHANNELS as C } from '../../../shared/communication'
import {
  FakeSender,
  registeredHandler,
  RENDERER_URL,
  resetIpcMocks
} from '../../__tests__/helpers/ipc-test-env'
import { TestAdapter } from '../../../core/communication/__tests__/test-adapter'
import { AdapterConnectionError } from '../../../core/communication/communication-adapter'
vi.mock('electron', async () =>
  (await import('../../__tests__/helpers/ipc-test-env')).electronTestModule()
)
const cleanups: Array<() => Promise<void>> = []
beforeEach(resetIpcMocks)
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
function setup(): {
  host: CommunicationHost
  connectionId: string
  invoke: (channel: string, value?: unknown) => unknown
  sender: FakeSender
  vault: CommunicationCredentialStore
  adapter: TestAdapter
  connectionState: () => string | undefined
} {
  const db = openDatabase(':memory:')
  const repository = new SqliteConversationRepository(db)
  const module = createTestConversationModule(
    {
      async *streamReply() {
        yield { type: 'text', delta: 'answer' }
      }
    },
    repository
  )
  const vault = { write: vi.fn(() => randomUUID()), read: vi.fn(() => 'SECRET'), remove: vi.fn() }
  const adapter = new TestAdapter(false)
  const host = new CommunicationHost(
    db,
    module,
    repository,
    vault,
    () => ({ uiLanguage: 'en', outputLanguage: 'en', targetLanguage: 'en' }),
    vi.fn(),
    [{ adapterId: 'test', create: () => adapter }]
  )
  const connectionId = host.service.addConnection('test')
  const dispose = registerCommunicationIpc(
    host,
    createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })
  )
  cleanups.push(async () => {
    dispose()
    await host.shutdown()
    await module.shutdown()
    db.close()
  })
  const sender = new FakeSender()
  const invoke = (channel: string, value?: unknown): unknown =>
    registeredHandler(channel)({ sender }, value)
  const connections = new SqliteCommunicationRepository(db)
  const connectionState = (): string | undefined =>
    connections.read((state) => state.connections.get(connectionId)?.state)
  return { host, connectionId, invoke, sender, vault, adapter, connectionState }
}
it('uses source and schema guards before changing any channel state', async () => {
  const f = setup()
  f.sender.owned = false
  expect(await f.invoke(C.start, { connectionId: f.connectionId })).toEqual({
    status: 'error',
    error: { code: 'UNTRUSTED_SOURCE' }
  })
  f.sender.owned = true
  expect(
    await f.invoke(C.start, { connectionId: f.connectionId, sessionId: randomUUID() })
  ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
  expect(f.connectionState()).toBe('stopped')
  expect(await f.invoke(C.start, { connectionId: f.connectionId })).toEqual({ status: 'ok' })
  expect(
    (await f.invoke(C.snapshot)) as { snapshot: { connections: Array<{ started: boolean }> } }
  ).toMatchObject({ snapshot: { connections: [{ started: true }] } })
  expect(await f.invoke(C.stop, { connectionId: f.connectionId })).toEqual({ status: 'ok' })
  expect(
    (await f.invoke(C.snapshot)) as { snapshot: { connections: Array<{ started: boolean }> } }
  ).toMatchObject({ snapshot: { connections: [{ started: false }] } })
  expect(await f.invoke(C.start, { connectionId: f.connectionId })).toEqual({ status: 'ok' })
  f.sender.destroy()
  expect(f.connectionState()).toBe('online')
})
it.each([
  ['TELEGRAM_WEBHOOK_CONFLICT', false, 'error'],
  ['TELEGRAM_NETWORK', true, 'reconnecting']
] as const)('returns a startup failure through IPC for %s', async (code, retryable, state) => {
  const f = setup()
  vi.spyOn(f.adapter, 'start').mockRejectedValueOnce(new AdapterConnectionError(retryable, code))
  expect(await f.invoke(C.start, { connectionId: f.connectionId })).toEqual({
    status: 'error',
    error: { code }
  })
  expect(f.connectionState()).toBe(state)
})

it('lets the desktop clear restart intent after a failed connection', async () => {
  const f = setup()
  vi.spyOn(f.adapter, 'start').mockRejectedValueOnce(
    new AdapterConnectionError(false, 'TELEGRAM_WEBHOOK_CONFLICT')
  )
  await f.invoke(C.start, { connectionId: f.connectionId })
  expect(await f.invoke(C.snapshot)).toMatchObject({
    snapshot: { connections: [{ started: false, autoStart: true }] }
  })
  expect(await f.invoke(C.stop, { connectionId: f.connectionId })).toEqual({ status: 'ok' })
  expect(f.connectionState()).toBe('stopped')
  await f.host.initialize()
  expect(f.adapter.start).toHaveBeenCalledTimes(1)
  expect(f.host.snapshot().connections[0].autoStart).toBeFalsy()
})

it('exposes no credentials, routing bodies, digests, internal sessions or cursors', async () => {
  const f = setup()
  await f.invoke(C.setCredential, { connectionId: f.connectionId, credential: 'SECRET' })
  expect(f.vault.write).toHaveBeenCalledWith('SECRET')
  const snapshot = await f.invoke(C.snapshot)
  expect(JSON.stringify(snapshot)).not.toMatch(/SECRET|credentialRef|digest|sessionId|cursor/)
  expect(snapshot).toEqual({
    status: 'ok',
    snapshot: {
      installedAdapters: [],
      connections: [
        {
          id: f.connectionId,
          adapterId: 'test',
          createdAt: expect.any(Number),
          started: false,
          bindingCount: 0
        }
      ]
    }
  })
  expect(
    await f.invoke(C.cancelRequest, { bindingId: randomUUID(), requestId: randomUUID() })
  ).toEqual({ status: 'error', error: { code: 'COMMUNICATION_FAILED' } })
})
it('guards Telegram creation and deletion with strict schemas and trusted sources', async () => {
  const f = setup()
  const create = vi.spyOn(f.host, 'createTelegramConnection')
  for (const value of [
    { token: 'invalid' },
    { token: '123456:abcdefghijklmnopqrstuvwxyz123456789', adapterId: 'other' },
    { token: '123456:abcdefghijklmnopqrstuvwxyz123456789', endpoint: 'https://example.com' }
  ]) {
    expect(await f.invoke(C.createTelegramConnection, value)).toEqual({
      status: 'error',
      error: { code: 'INVALID_INPUT' }
    })
  }
  expect(create).not.toHaveBeenCalled()
  f.sender.owned = false
  expect(
    await f.invoke(C.createTelegramConnection, {
      token: '123456:abcdefghijklmnopqrstuvwxyz123456789'
    })
  ).toEqual({ status: 'error', error: { code: 'UNTRUSTED_SOURCE' } })
  expect(await f.invoke(C.deleteConnection, { connectionId: f.connectionId })).toEqual({
    status: 'error',
    error: { code: 'UNTRUSTED_SOURCE' }
  })
})

it('validates source and connection ID before testing and maps failures safely', async () => {
  const f = setup()
  const test = vi.spyOn(f.host, 'testConnection').mockResolvedValueOnce(undefined)
  f.sender.owned = false
  expect(await f.invoke(C.testConnection, { connectionId: f.connectionId })).toEqual({
    status: 'error',
    error: { code: 'UNTRUSTED_SOURCE' }
  })
  f.sender.owned = true
  expect(
    await f.invoke(C.testConnection, { connectionId: f.connectionId, credential: 'SECRET' })
  ).toEqual({
    status: 'error',
    error: { code: 'INVALID_INPUT' }
  })
  expect(test).not.toHaveBeenCalled()
  expect(await f.invoke(C.testConnection, { connectionId: f.connectionId })).toEqual({
    status: 'ok'
  })
  expect(test).toHaveBeenCalledWith(f.connectionId)
  test.mockRejectedValueOnce(new Error('SECRET'))
  expect(await f.invoke(C.testConnection, { connectionId: f.connectionId })).toEqual({
    status: 'error',
    error: { code: 'COMMUNICATION_FAILED' }
  })
})

it('guards binding creation and confirmation and returns an actionable expired-code error', async () => {
  const f = setup()
  const create = vi.spyOn(f.host.service, 'createChallenge')
  const confirm = vi.spyOn(f.host.service, 'confirmBinding')
  f.sender.owned = false
  expect(
    await f.invoke(C.createChallenge, { connectionId: f.connectionId, capabilities: ['chat'] })
  ).toEqual({ status: 'error', error: { code: 'UNTRUSTED_SOURCE' } })
  expect(await f.invoke(C.confirmBinding, { challengeId: randomUUID() })).toEqual({
    status: 'error',
    error: { code: 'UNTRUSTED_SOURCE' }
  })
  f.sender.owned = true
  expect(
    await f.invoke(C.createChallenge, { connectionId: f.connectionId, capabilities: ['tts'] })
  ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
  expect(
    await f.invoke(C.confirmBinding, { challengeId: randomUUID(), externalActorId: 'forged' })
  ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
  expect(create).not.toHaveBeenCalled()
  expect(confirm).not.toHaveBeenCalled()
  expect(await f.invoke(C.confirmBinding, { challengeId: randomUUID() })).toEqual({
    status: 'error',
    error: { code: 'CHALLENGE_INVALID' }
  })
  expect(
    await f.invoke(C.createChallenge, {
      connectionId: f.connectionId,
      capabilities: ['chat', 'sentence']
    })
  ).toMatchObject({
    status: 'ok',
    challengeId: expect.any(String),
    code: expect.any(String),
    expiresAt: expect.any(Number)
  })
})
