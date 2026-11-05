import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { openDatabase } from '../../../database/database'
import { SqliteCommunicationRepository } from '../../../database/sqlite-communication-repository'
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
  connectionState: (id: string) => string | undefined
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
  const connections = new SqliteCommunicationRepository(db)
  const connectionState = (id: string): string | undefined =>
    connections.read((state) => state.connections.get(id)?.state)
  return { host, credentials, verify, adapter, db, connectionState }
}
it('creates stopped verified connections without exposing secrets and serializes duplicate Bot creation', async () => {
  const f = fixture()
  const results = await Promise.allSettled([
    f.host.createTelegramConnection(token),
    f.host.createTelegramConnection(token)
  ])
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
  expect(f.credentials.write).toHaveBeenCalledTimes(1)
  expect(results[0]).toMatchObject({ status: 'fulfilled' })
  if (results[0].status !== 'fulfilled') throw results[0].reason
  const id = results[0].value
  expect(f.connectionState(id)).toBe('stopped')
  expect(f.host.snapshot().connections).toMatchObject([{ id, username: 'lingo_bot' }])
  expect(JSON.stringify(f.host.snapshot())).not.toContain(token)
})
it('projects binding progress without exposing codes or digests and requires desktop confirmation', async () => {
  const f = fixture()
  const id = await f.host.createTelegramConnection(token)
  expect(f.host.snapshot().connections[0]).toMatchObject({ bindingCount: 0 })
  const challenge = f.host.service.createChallenge(id, ['chat', 'sentence'])
  expect(f.host.snapshot().connections[0]).toMatchObject({
    bindingChallenge: { challengeId: challenge.challengeId, expiresAt: challenge.expiresAt }
  })
  await f.host.start(id)
  const receipt = await f.adapter.receive({
    type: 'text',
    externalEventId: '1',
    externalMessageId: '1',
    externalActorId: '12345',
    externalConversationId: '12345',
    displayName: 'Alice',
    scope: 'private',
    occurredAt: Date.now(),
    text: `/bind ${challenge.code}`
  })
  expect(receipt.code).toBe('AWAITING_CONFIRMATION')
  const snapshot = f.host.snapshot()
  expect(snapshot.connections[0]).toMatchObject({
    bindingCount: 0,
    bindingChallenge: {
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      externalActorId: '12345',
      displayName: 'Alice'
    }
  })
  expect(JSON.stringify(snapshot)).not.toMatch(/digest|capabilities|principalId|credentialRef/)
  expect(JSON.stringify(snapshot)).not.toContain(challenge.code)
  f.host.service.confirmBinding(challenge.challengeId)
  expect(f.host.snapshot().connections[0]).toMatchObject({ bindingCount: 1 })
  expect(f.host.snapshot().connections[0].bindingChallenge).toBeUndefined()
})
it('omits expired, exhausted and superseded binding challenges from the desktop snapshot', async () => {
  const f = fixture()
  const id = await f.host.createTelegramConnection(token)
  const first = f.host.service.createChallenge(id, ['chat'])
  const current = f.host.service.createChallenge(id, ['chat'])
  expect(f.host.snapshot().connections[0].bindingChallenge?.challengeId).toBe(current.challengeId)
  const repository = new SqliteCommunicationRepository(f.db)
  repository.transaction((s) => {
    s.challenges.get(current.challengeId)!.expiresAt = Date.now() - 1
  })
  expect(f.host.snapshot().connections[0].bindingChallenge).toBeUndefined()
  const exhausted = f.host.service.createChallenge(id, ['chat'])
  repository.transaction((s) => {
    s.challenges.get(exhausted.challengeId)!.attempts = 5
  })
  expect(f.host.snapshot().connections[0].bindingChallenge).toBeUndefined()
  expect(() => f.host.service.confirmBinding(first.challengeId)).toThrow('CHALLENGE_INVALID')
})
it('stops before rotation, refuses a different bot, retains the old reference and requires explicit restart', async () => {
  const f = fixture()
  const id = await f.host.createTelegramConnection(token)
  await f.host.start(id)
  f.verify.mockResolvedValueOnce({ botId: '999', username: 'other_bot' })
  await expect(f.host.setCredential(id, token)).rejects.toThrow('TELEGRAM_BOT_MISMATCH')
  expect(f.connectionState(id)).toBe('stopped')
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
  expect(f.connectionState(id)).toBe('error')
  expect(f.host.snapshot().connections).toMatchObject([{ id, deleting: true }])
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

it('persists the time of creation and preserves it through credential rotation', async () => {
  const f = fixture()
  const id = await f.host.createTelegramConnection(token)
  const snapshot = f.host.snapshot()
  const createdAt = snapshot.connections[0].createdAt
  expect(createdAt).toEqual(expect.any(Number))
  expect(
    f.db
      .prepare(
        "SELECT json_extract(data, '$.createdAt') AS createdAt FROM communication_connections WHERE id = ?"
      )
      .get(id)
  ).toEqual({ createdAt })
  await f.host.setCredential(id, token)
  expect(f.host.snapshot().connections[0].createdAt).toBe(createdAt)
  f.db
    .prepare(
      "UPDATE communication_connections SET data = json_remove(data, '$.createdAt') WHERE id = ?"
    )
    .run(id)
  expect(f.host.snapshot().connections[0].createdAt).toBeUndefined()
})

it('persists an auto-start marker and resumes only marked connections after a restart', async () => {
  const f = fixture()
  const marked = await f.host.createTelegramConnection(token)
  f.verify.mockResolvedValueOnce({ botId: '654321', username: 'other_bot' })
  const unmarked = await f.host.createTelegramConnection(token)
  expect(f.host.snapshot().connections).toMatchObject([
    { id: marked, started: false },
    { id: unmarked, started: false }
  ])
  await f.host.start(marked)
  expect(
    f.db
      .prepare(
        "SELECT json_extract(data, '$.autoStart') AS autoStart FROM communication_connections WHERE id = ?"
      )
      .get(marked)
  ).toEqual({ autoStart: 1 })
  expect(f.host.snapshot().connections).toMatchObject([
    { id: marked, started: true },
    { id: unmarked, started: false }
  ])
  await f.host.shutdown()
  const repository = new SqliteConversationRepository(f.db)
  const module = createTestConversationModule(
    {
      async *streamReply() {
        yield { type: 'text', delta: 'answer' }
      }
    },
    repository
  )
  const relaunched = new CommunicationHost(
    f.db,
    module,
    repository,
    { write: vi.fn(() => randomUUID()), read: vi.fn(() => token), remove: vi.fn() },
    () => ({ uiLanguage: 'en', outputLanguage: 'en', targetLanguage: 'en' }),
    vi.fn(),
    [{ adapterId: 'telegram', create: () => new TestAdapter(false), startAsHelp: true }]
  )
  // Runs before the fixture cleanup closes the shared database handle.
  close.unshift(async () => {
    await relaunched.shutdown()
    await module.shutdown()
  })
  await relaunched.initialize()
  await vi.waitFor(() => expect(f.connectionState(marked)).toBe('online'))
  expect(f.connectionState(unmarked)).toBe('stopped')
  expect(relaunched.snapshot().connections).toMatchObject([
    { id: marked, started: true },
    { id: unmarked, started: false }
  ])
  await relaunched.stop(marked)
  expect(
    f.db
      .prepare(
        "SELECT json_extract(data, '$.autoStart') AS autoStart FROM communication_connections WHERE id = ?"
      )
      .get(marked)
  ).toEqual({ autoStart: 0 })
})

it('tests the selected stored credential without starting a connection or writing data', async () => {
  const f = fixture()
  await f.host.createTelegramConnection(token)
  const otherToken = '654321:abcdefghijklmnopqrstuvwxyz123456789'
  f.verify.mockResolvedValueOnce({ botId: '654321', username: 'other_bot' })
  const other = await f.host.createTelegramConnection(otherToken)
  const reference = f.credentials.write.mock.results[1].value
  f.credentials.read.mockReturnValueOnce(otherToken)
  f.verify.mockResolvedValueOnce({ botId: '654321', username: 'other_bot' })
  const start = vi.spyOn(f.adapter, 'start')
  const before = f.db.prepare('SELECT * FROM communication_connections').all()
  await expect(f.host.testConnection(other)).resolves.toBeUndefined()
  expect(f.credentials.read).toHaveBeenCalledWith(reference)
  expect(f.verify).toHaveBeenLastCalledWith(otherToken, expect.any(AbortSignal))
  expect(start).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT * FROM communication_connections').all()).toEqual(before)
  expect(f.credentials.write).toHaveBeenCalledTimes(2)
  expect(f.credentials.remove).not.toHaveBeenCalled()
})

it.each(['TELEGRAM_NETWORK', 'TELEGRAM_UNAUTHORIZED', 'TELEGRAM_BOT_MISMATCH'])(
  'rejects an unsuccessful connectivity test with %s',
  async (code) => {
    const f = fixture()
    const id = await f.host.createTelegramConnection(token)
    if (code === 'TELEGRAM_BOT_MISMATCH')
      f.verify.mockResolvedValueOnce({ botId: '999', username: 'other_bot' })
    else f.verify.mockRejectedValueOnce(new Error(code))
    await expect(f.host.testConnection(id)).rejects.toThrow(code)
  }
)
