import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { ConversationModule } from '../../src/core/conversation/conversation-module'
import { ConversationPersistenceError } from '../../src/core/conversation/conversation-repository'
import type { LanguageModel, StreamReplyInput } from '../../src/core/llm/language-model'
import type { ConversationEvent, GenerationAccepted } from '../../src/shared/conversation'
import { openDatabase } from '../../src/database/database'
import { SqliteConversationRepository } from '../../src/database/sqlite-conversation-repository'

const databases: Database.Database[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function setup(model: LanguageModel): {
  database: Database.Database
  repository: SqliteConversationRepository
  module: ConversationModule
} {
  const database = openDatabase(':memory:')
  databases.push(database)
  const repository = new SqliteConversationRepository(database)
  const module = new ConversationModule(model, repository, () => ({
    outputLanguage: 'en',
    targetLanguage: 'en'
  }))
  return { database, repository, module }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function send(
  module: ConversationModule,
  sessionId: string,
  text = 'Practice ordering coffee'
): Promise<{ accepted: GenerationAccepted; events: ConversationEvent[] }> {
  const terminal = deferred()
  const events: ConversationEvent[] = []
  const accepted = await module.sendMessage(
    { sessionId, requestId: randomUUID(), text },
    (event) => {
      events.push(event)
      if (['completed', 'failed', 'cancelled'].includes(event.type)) terminal.resolve()
    }
  )
  await terminal.promise
  return { accepted, events }
}

describe('first-message conversation titles', () => {
  it('finishes replies while the title is pending, then updates only the title', async () => {
    const finishTitle = deferred()
    const calls: StreamReplyInput[] = []
    const { module, repository } = setup({
      async *streamReply(input) {
        calls.push(input)
        if (input.promptKind === 'conversation-title') {
          await finishTitle.promise
          yield 'Coffee practice'
        } else yield 'What would you like?'
      }
    })
    const { sessionId } = await module.createConversation()
    const first = await send(module, sessionId)
    expect(first.events.map(({ type }) => type)).toEqual(['started', 'chunk', 'completed'])
    expect((await repository.find(sessionId))?.title).toBe('Practice ordering coffee')
    await send(module, sessionId, 'Now tea')
    const before = await repository.find(sessionId)
    finishTitle.resolve()
    await vi.waitFor(() => expect(first.events.some((e) => e.type === 'titleUpdated')).toBe(true))
    expect(await repository.find(sessionId)).toEqual({ ...before, title: 'Coffee practice' })
    expect(calls.filter(({ promptKind }) => promptKind === 'conversation-title')).toHaveLength(1)
    expect(calls[0]).toMatchObject({ outputLanguage: 'en', targetLanguage: 'en' })
  })

  it.each(['', '   ', 'a'.repeat(41), 'line one\nline two'])(
    'keeps the input title when the summary is invalid: %j',
    async (title) => {
      const { module, repository } = setup({
        async *streamReply(input) {
          yield input.promptKind === 'conversation-title' ? title : 'Reply'
        }
      })
      const { sessionId } = await module.createConversation()
      const { events } = await send(module, sessionId)
      expect(events.at(-1)?.type).toBe('completed')
      expect((await repository.find(sessionId))?.title).toBe('Practice ordering coffee')
    }
  )

  it('keeps the input title when title generation fails', async () => {
    const { module, repository } = setup({
      async *streamReply(input) {
        if (input.promptKind === 'conversation-title') {
          yield 'Partial'
          throw new Error('network failed')
        }
        yield 'Reply'
      }
    })
    const { sessionId } = await module.createConversation()
    const { events } = await send(module, sessionId)
    expect(events.at(-1)?.type).toBe('completed')
    expect((await repository.find(sessionId))?.title).toBe('Practice ordering coffee')
  })

  it('does not persist a late title after cancellation', async () => {
    const gate = deferred()
    const { module, repository } = setup({
      async *streamReply() {
        await gate.promise
        yield 'Coffee practice'
      }
    })
    const { sessionId } = await module.createConversation()
    const requestId = randomUUID()
    const events: ConversationEvent[] = []
    await module.sendMessage({ sessionId, requestId, text: 'Coffee' }, (e) => events.push(e))
    module.cancelMessage(requestId)
    gate.resolve()
    await vi.waitFor(() => expect(events.some((e) => e.type === 'cancelled')).toBe(true))
    expect((await repository.find(sessionId))?.title).toBe('Coffee')
    expect(await repository.history(sessionId)).toHaveLength(1)
  })

  it('rolls back conversation creation when writing the first message fails', async () => {
    const { module, repository, database } = setup({
      async *streamReply() {
        yield 'Coffee practice'
      }
    })
    const { sessionId } = await module.createConversation()
    database.exec(
      "CREATE TRIGGER fail_message BEFORE INSERT ON conversation_messages BEGIN SELECT RAISE(ABORT, 'forced failure'); END"
    )
    await expect(send(module, sessionId)).rejects.toThrow(ConversationPersistenceError)
    expect(await repository.list()).toEqual([])
    database.exec('DROP TRIGGER fail_message')
    await send(module, sessionId)
    expect(await repository.list()).toHaveLength(1)
  })
})
