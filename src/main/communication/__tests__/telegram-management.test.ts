import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { openDatabase } from '../../../database/database'
import { SqliteConversationRepository } from '../../../database/sqlite-conversation-repository'
import { createTestConversationModule } from '../../../../tests/fixtures/conversation'
import { CommunicationHost } from '../communication-host'
import { TestAdapter } from '../../../core/communication/__tests__/test-adapter'
const token = '123456:abcdefghijklmnopqrstuvwxyz123456789'
const close: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup()
})
function fixture(): {
  host: CommunicationHost
  credentials: { write: Mock<() => string>; read: Mock<() => string>; remove: Mock }
  verify: Mock<() => Promise<{ botId: string; username: string }>>
  adapter: TestAdapter
  db: ReturnType<typeof openDatabase>
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
  const credentials = {
    write: vi.fn(() => randomUUID()),
    read: vi.fn(() => token),
    remove: vi.fn()
  }
  const verify = vi.fn(async () => ({ botId: '123456', username: 'lingo_bot' }))
  const adapter = new TestAdapter(false)
  const host = new CommunicationHost(
    db,
    module,
    repository,
    credentials,
    () => ({ uiLanguage: 'en', outputLanguage: 'en', targetLanguage: 'en' }),
    vi.fn(),
    [{ adapterId: 'telegram', create: () => adapter, verifyCredential: verify, startAsHelp: true }]
  )
  close.push(async () => {
    await host.shutdown()
    await module.shutdown()
    db.close()
  })
  return { host, credentials, verify, adapter, db }
}
it('creates stopped verified connections without exposing secrets and serializes duplicate Bot creation', async () => {
  const f = fixture()
  const results = await Promise.allSettled([
    f.host.createTelegramConnection(token),
    f.host.createTelegramConnection(token)
  ])
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
  expect(f.credentials.write).toHaveBeenCalledTimes(1)
  expect(f.host.snapshot().connections).toMatchObject([
    { state: 'stopped', botId: '123456', username: 'lingo_bot', hasCredential: true }
  ])
  expect(JSON.stringify(f.host.snapshot())).not.toContain(token)
})
it('stops before rotation, refuses a different bot, retains the old reference and requires explicit restart', async () => {
  const f = fixture()
  const id = await f.host.createTelegramConnection(token)
  await f.host.start(id)
  f.verify.mockResolvedValueOnce({ botId: '999', username: 'other_bot' })
  await expect(f.host.setCredential(id, token)).rejects.toThrow('TELEGRAM_BOT_MISMATCH')
  expect(f.host.snapshot().connections[0].state).toBe('stopped')
  expect(f.credentials.write).toHaveBeenCalledTimes(1)
  await f.host.setCredential(id, token)
  expect(f.credentials.write).toHaveBeenCalledTimes(2)
  expect(f.credentials.remove).toHaveBeenCalledTimes(1)
  await f.host.deleteConnection(id)
  await f.host.deleteConnection(id)
  expect(f.host.snapshot().connections).toEqual([])
})
it('cleans up newly written credentials if SQLite commit fails', async () => {
  const f = fixture()
  f.db.exec(
    "CREATE TRIGGER fail_create BEFORE INSERT ON communication_connections BEGIN SELECT RAISE(ABORT, 'disk'); END"
  )
  await expect(f.host.createTelegramConnection(token)).rejects.toThrow()
  expect(f.credentials.remove).toHaveBeenCalledWith(f.credentials.write.mock.results[0].value)
})
it('keeps failed deletion visible and retryable without admitting a replacement consumer', async () => {
  const f = fixture()
  const id = await f.host.createTelegramConnection(token)
  await f.host.start(id)
  vi.spyOn(f.adapter, 'stop').mockRejectedValueOnce(new Error('cannot stop'))
  await expect(f.host.deleteConnection(id)).rejects.toThrow('CONNECTION_STOP_FAILED')
  expect(f.host.snapshot().connections).toMatchObject([{ id, state: 'error', deleting: true }])
  await expect(f.host.createTelegramConnection(token)).rejects.toThrow('TELEGRAM_DUPLICATE_BOT')
  await f.host.deleteConnection(id)
  expect(f.host.snapshot().connections).toEqual([])
})
it('shuts down without waiting for a credential verifier that ignores cancellation and prevents late writes', async () => {
  const f = fixture()
  let release!: (identity: { botId: string; username: string }) => void
  f.verify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const creating = f.host.createTelegramConnection(token).catch((error: unknown) => error)
  await vi.waitFor(() => expect(release).toBeDefined())
  const shutdown = f.host.shutdown()
  const stopped = await Promise.race([
    shutdown.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30))
  ])
  release({ botId: '123456', username: 'lingo_bot' })
  await creating
  await shutdown
  expect(stopped).toBe(true)
  expect(f.credentials.write).not.toHaveBeenCalled()
})
