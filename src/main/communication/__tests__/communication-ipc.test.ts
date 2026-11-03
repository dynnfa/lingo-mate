import type { CommunicationCredentialStore } from '../credential-store'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../database/database'
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
  const host = new CommunicationHost(
    db,
    module,
    repository,
    vault,
    () => ({ uiLanguage: 'en', outputLanguage: 'en', targetLanguage: 'en' }),
    vi.fn(),
    [{ adapterId: 'test', create: () => new TestAdapter(false) }]
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
  return { host, connectionId, invoke, sender, vault }
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
  expect(f.host.snapshot().connections[0].state).toBe('stopped')
  expect(await f.invoke(C.start, { connectionId: f.connectionId })).toEqual({ status: 'ok' })
  f.sender.destroy()
  expect(f.host.snapshot().connections[0].state).toBe('online')
})
it('exposes no credentials, routing bodies, digests, internal sessions or cursors', async () => {
  const f = setup()
  await f.invoke(C.setCredential, { connectionId: f.connectionId, credential: 'SECRET' })
  expect(f.vault.write).toHaveBeenCalledWith('SECRET')
  const snapshot = await f.invoke(C.snapshot)
  expect(JSON.stringify(snapshot)).not.toMatch(/SECRET|credentialRef|digest|sessionId|cursor/)
  expect(snapshot).toMatchObject({
    status: 'ok',
    snapshot: { connections: [{ hasCredential: true }] }
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
