import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { openDatabase } from '../../../database/database'
import { SqliteConversationRepository } from '../../../database/sqlite-conversation-repository'
import { createTestConversationModule } from '../../../../tests/fixtures/conversation'
import type { ConversationEvent } from '../../../shared/conversation'
it('creates durable channel sessions and uses explicit languages and durable message identities', async () => {
  const db = openDatabase(':memory:')
  try {
    const repository = new SqliteConversationRepository(db)
    const prompts: string[] = []
    const module = createTestConversationModule(
      {
        async *streamReply(input) {
          prompts.push(input.systemPrompt)
          yield { type: 'text', delta: 'Answer' }
        }
      },
      repository,
      () => ({ outputLanguage: 'en', targetLanguage: 'en' })
    )
    const sessionId = randomUUID(),
      userMessageId = randomUUID(),
      assistantMessageId = randomUUID()
    await module.createPersistentConversation(sessionId, 'Channel')
    expect(await repository.find(sessionId)).toBeDefined()
    const events: ConversationEvent[] = []
    await module.sendMessage(
      { requestId: randomUUID(), sessionId, text: 'hello' },
      (event) => events.push(event),
      {
        languages: { outputLanguage: 'zh-CN', targetLanguage: 'en' },
        userMessageId,
        assistantMessageId
      }
    )
    await vi.waitFor(() => expect(events.some((e) => e.type === 'completed')).toBe(true))
    await module.shutdown()
    expect(prompts[0]).toContain('Simplified Chinese (zh-CN)')
    const history = await repository.history(sessionId)
    expect(history.map((m) => m.id)).toEqual([userMessageId, assistantMessageId])
    expect(events.some((e) => e.type === 'completed')).toBe(true)
  } finally {
    db.close()
  }
})
it('shares the existing busy guard between desktop and channel requests', async () => {
  const db = openDatabase(':memory:')
  try {
    const repository = new SqliteConversationRepository(db)
    let release!: () => void
    const module = createTestConversationModule(
      {
        async *streamReply() {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          yield { type: 'text', delta: 'saved' }
        }
      },
      repository
    )
    const sessionId = randomUUID()
    await module.createPersistentConversation(sessionId, 'Shared session')
    const events: ConversationEvent[] = []
    await module.sendMessage({ requestId: randomUUID(), sessionId, text: 'desktop' }, (event) =>
      events.push(event)
    )
    await vi.waitFor(() => expect(release).toBeDefined())
    const { ConversationBusinessPort } =
      await import('../../../main/communication/conversation-business-port')
    const port = new ConversationBusinessPort(module, repository)
    const channel = port.execute(
      {
        requestId: randomUUID(),
        sessionId,
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        operation: 'chat',
        text: 'channel',
        languages: { uiLanguage: 'en', outputLanguage: 'en', targetLanguage: 'en' }
      },
      new AbortController().signal
    )
    expect(await channel).toEqual({ status: 'failed' })
    release()
    await vi.waitFor(() => expect(events.some((e) => e.type === 'completed')).toBe(true))
    await module.shutdown()
    expect((await repository.history(sessionId)).map((m) => m.content)).toEqual([
      'desktop',
      'saved'
    ])
  } finally {
    db.close()
  }
})
