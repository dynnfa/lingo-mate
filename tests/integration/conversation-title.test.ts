import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { ConversationModule } from '../../src/core/conversation/conversation-module'
import {
  ConversationBusyError,
  ConversationPersistenceError
} from '../../src/core/conversation/conversation-repository'
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
  it('waits for the full title, blocks concurrent sends, and generates it only once', async () => {
    const entered = deferred()
    const finishTitle = deferred()
    const calls: StreamReplyInput[] = []
    const { module, repository } = setup({
      async *streamReply(input) {
        calls.push(input)
        if (input.promptKind === 'conversation-title') {
          yield 'Coffee '
          entered.resolve()
          await finishTitle.promise
          yield 'practice'
        } else yield 'What would you like?'
      }
    })
    const draft = await module.createConversation()
    const pending = send(module, draft.sessionId)
    await entered.promise
    expect(await repository.list()).toEqual([])
    expect(await repository.history(draft.sessionId)).toEqual([])
    await expect(send(module, draft.sessionId, 'Another message')).rejects.toThrow(
      ConversationBusyError
    )
    finishTitle.resolve()
    const first = await pending
    expect(first.events.map(({ type }) => type)).toEqual(['started', 'chunk', 'completed'])
    expect((await repository.find(draft.sessionId))?.title).toBe('Coffee practice')
    await send(module, draft.sessionId, 'Now tea')
    expect(calls.filter(({ promptKind }) => promptKind === 'conversation-title')).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      outputLanguage: 'en',
      messages: [{ role: 'user', content: 'Practice ordering coffee' }]
    })
    expect((await repository.history(draft.sessionId)).map(({ role }) => role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant'
    ])
  })

  it.each(['', '   ', 'a'.repeat(81), 'line one\nline two'])(
    'rejects invalid title %j without writing and allows resending',
    async (invalid) => {
      let title = invalid
      const { module, repository } = setup({
        async *streamReply() {
          yield title
        }
      })
      const { sessionId } = await module.createConversation()
      await expect(send(module, sessionId)).rejects.toThrow()
      expect(await repository.list()).toEqual([])
      expect(await repository.history(sessionId)).toEqual([])
      title = 'Coffee practice'
      await send(module, sessionId)
      expect((await repository.find(sessionId))?.title).toBe(title)
    }
  )

  it('discards partial titles on model failure', async () => {
    const { module, repository } = setup({
      async *streamReply() {
        yield 'Partial'
        throw new Error('network failed')
      }
    })
    const { sessionId } = await module.createConversation()
    await expect(send(module, sessionId)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'network failed' })
    })
    expect(await repository.list()).toEqual([])
    expect(await repository.history(sessionId)).toEqual([])
  })

  it('does not persist a late title after cancellation and releases the session for resending', async () => {
    const entered = deferred()
    const finishTitle = deferred()
    const { module, repository } = setup({
      async *streamReply() {
        entered.resolve()
        await finishTitle.promise
        yield 'Coffee practice'
      }
    })
    const { sessionId } = await module.createConversation()
    const requestId = randomUUID()
    const pending = module.sendMessage({ sessionId, requestId, text: 'Coffee' }, () => {})
    await entered.promise
    module.cancelMessage(requestId)
    finishTitle.resolve()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(await repository.list()).toEqual([])
    expect(await repository.history(sessionId)).toEqual([])
    await send(module, sessionId)
    expect(await repository.list()).toHaveLength(1)
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
