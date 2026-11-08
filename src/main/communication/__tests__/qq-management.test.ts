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

it('preserves the encrypted reference when QQ Secret replacement fails and clears auto-start', async () => {
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
  expect(host.snapshot().connections[0].autoStart).toBe(true)
  verify.mockRejectedValueOnce(new Error('invalid fixture secret'))
  await expect(host.replaceQqSecret(id, 'BAD_SECRET')).rejects.toThrow()
  expect(stop).toHaveBeenCalledOnce()
  expect(host.snapshot().connections[0].autoStart).toBeUndefined()
  expect(state().credentialRef).toBe(previous)
  expect(credentials.write).toHaveBeenCalledTimes(1)
  await host.testConnection(id)
  expect(verify).toHaveBeenLastCalledWith('123456', 'OLD_SECRET', expect.any(AbortSignal))
  await host.replaceQqSecret(id, 'NEW_SECRET')
  expect(values.get(state().credentialRef!)).toBe('NEW_SECRET')
  expect(credentials.remove).toHaveBeenCalledWith(previous)
  expect(host.snapshot().connections[0].state).toBe('stopped')
  expect(JSON.stringify(host.snapshot())).not.toMatch(/SECRET|credentialRef|cursor/)
})

it('starts marked QQ and Telegram channels independently after relaunch and honors an explicit stop', async () => {
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
  const credentials = { write: () => randomUUID(), read: () => 'fixture', remove: vi.fn() }
  const createHost = (qq: TestAdapter, telegram: TestAdapter): CommunicationHost =>
    new CommunicationHost(
      db,
      module,
      repository,
      credentials,
      () => ({ uiLanguage: 'en', outputLanguage: 'en', targetLanguage: 'en' }),
      vi.fn(),
      [
        { adapterId: 'qq', sessionCursor: true, create: () => qq, verifyQqCredential: vi.fn() },
        {
          adapterId: 'telegram',
          create: () => telegram,
          verifyCredential: async () => ({ botId: '123456', username: 'lingo_bot' })
        }
      ]
    )
  const previousQq = new TestAdapter(false)
  const initial = createHost(previousQq, new TestAdapter(false))
  const qq = new TestAdapter(false)
  const telegram = new TestAdapter(false)
  const relaunched = createHost(qq, telegram)
  close.push(async () => {
    await initial.shutdown()
    await relaunched.shutdown()
    await module.shutdown()
    db.close()
  })
  const qqId = await initial.createQqConnection('123456', 'SECRET')
  const telegramId = await initial.createTelegramConnection(
    '123456:abcdefghijklmnopqrstuvwxyz123456789'
  )
  const stoppedId = await initial.createQqConnection('654321', 'OTHER_SECRET')
  await initial.start(stoppedId)
  await initial.stop(stoppedId)
  await initial.start(qqId)
  const receipt = await previousQq.context!.receiveRejected(
    { externalEventId: 'old-event', kind: 'invalid', digest: 'a'.repeat(64) },
    'old-session-cursor'
  )
  expect(receipt.status).toBe('rejected')
  await initial.start(telegramId)
  await initial.shutdown()

  let ready!: () => void
  const handshake = new Promise<void>((resolve) => {
    ready = resolve
  })
  const startQq = qq.start.bind(qq)
  vi.spyOn(qq, 'start').mockImplementationOnce(async (context) => {
    await startQq(context)
    await handshake
  })
  const connection = (
    id: string
  ): ReturnType<CommunicationHost['snapshot']>['connections'][number] | undefined =>
    relaunched.snapshot().connections.find((item) => item.id === id)
  try {
    await relaunched.initialize()
    await vi.waitFor(() => expect(telegram.context).toBeDefined())
    expect(connection(telegramId)).toMatchObject({ started: true, autoStart: true })
    expect(connection(qqId)).toMatchObject({ state: 'starting', autoStart: true })
    expect(qq.context).toBeDefined()
    expect(qq.context?.cursor).toBeUndefined()
    expect(connection(stoppedId)).toMatchObject({ state: 'stopped', started: false })
    expect(connection(stoppedId)?.autoStart).toBeUndefined()
    ready()
    await vi.waitFor(() => expect(connection(qqId)?.state).toBe('online'))
    await relaunched.stop(qqId)
    expect(connection(qqId)?.autoStart).toBeUndefined()
    expect(telegram.context?.signal.aborted).toBe(false)
    expect(connection(telegramId)?.started).toBe(true)
  } finally {
    ready()
  }
})
