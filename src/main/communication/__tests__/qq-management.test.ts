import type { Connection } from '../../../core/communication/communication-repository'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../database/database'
import { SqliteCommunicationRepository } from '../../../database/sqlite-communication-repository'
import { SqliteConversationRepository } from '../../../database/sqlite-conversation-repository'
import { createTestConversationModule } from '../../../../tests/fixtures/conversation'
import { CommunicationHost } from '../communication-host'
import { TestAdapter } from '../../../core/communication/__tests__/test-adapter'
const close: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup()
})

it('keeps QQ stopped after recovery and preserves the encrypted reference when Secret replacement fails', async () => {
  const db = openDatabase(':memory:')
  const repository = new SqliteConversationRepository(db)
  const communication = new SqliteCommunicationRepository(db)
  const module = createTestConversationModule(
    {
      async *streamReply() {
        yield { type: 'text', delta: 'answer' }
      }
    },
    repository
  )
  const verify = vi.fn()
  const values = new Map<string, string>()
  const credentials = {
    write: vi.fn((secret: string) => {
      const key = randomUUID()
      values.set(key, secret)
      return key
    }),
    read: vi.fn((ref: string) => values.get(ref)!),
    remove: vi.fn((ref: string) => {
      values.delete(ref)
    })
  }
  const adapter = new TestAdapter(false)
  const start = vi.spyOn(adapter, 'start')
  const stop = vi.spyOn(adapter, 'stop')
  const host = new CommunicationHost(
    db,
    module,
    repository,
    credentials,
    () => ({ uiLanguage: 'en', outputLanguage: 'en', targetLanguage: 'en' }),
    vi.fn(),
    [{ adapterId: 'qq', sessionCursor: true, create: () => adapter, verifyQqCredential: verify }]
  )
  close.push(async () => {
    await host.shutdown()
    await module.shutdown()
    db.close()
  })
  const id = await host.createQqConnection('123456', 'OLD_SECRET')
  await expect(host.createQqConnection('123456', 'OTHER_SECRET')).rejects.toThrow(
    'QQ_DUPLICATE_APP'
  )
  expect(host.snapshot()).toMatchObject({
    installedAdapters: ['qq'],
    connections: [{ id, appId: '123456', state: 'stopped', credentialSaved: true }]
  })
  const state = (): Connection => communication.read((s) => s.connections.get(id)!)
  const previous = state().credentialRef
  await host.start(id)
  expect(state().autoStart).toBe(false)
  verify.mockRejectedValueOnce(new Error('invalid fixture secret'))
  await expect(host.replaceQqSecret(id, 'BAD_SECRET')).rejects.toThrow()
  expect(stop).toHaveBeenCalledOnce()
  expect(state().credentialRef).toBe(previous)
  expect(credentials.write).toHaveBeenCalledTimes(1)
  await host.testConnection(id)
  expect(verify).toHaveBeenLastCalledWith('123456', 'OLD_SECRET', expect.any(AbortSignal))
  await host.replaceQqSecret(id, 'NEW_SECRET')
  expect(values.get(state().credentialRef!)).toBe('NEW_SECRET')
  expect(credentials.remove).toHaveBeenCalledWith(previous)
  await host.start(id)
  await host.initialize()
  expect(start).toHaveBeenCalledTimes(2)
  expect(host.snapshot().connections[0].state).toBe('stopped')
  expect(JSON.stringify(host.snapshot())).not.toMatch(/SECRET|credentialRef|cursor/)
})
