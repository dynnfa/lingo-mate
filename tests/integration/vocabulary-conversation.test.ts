import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationEvent } from '../../src/shared/conversation'
import type { LanguageModel } from '../../src/core/llm/language-model'
import { ConversationModule } from '../../src/core/conversation/conversation-module'
import { VocabularyConversationSkill } from '../../src/core/learning/vocabulary/vocabulary-conversation-skill'
import { recognized } from '../../src/core/learning/vocabulary/__tests__/fixtures'
import { openDatabase } from '../../src/database/database'
import { SqliteConversationRepository } from '../../src/database/sqlite-conversation-repository'
import { SqliteVocabularyRepository } from '../../src/database/sqlite-vocabulary-repository'

const databases: ReturnType<typeof openDatabase>[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const unusedConversationModel: LanguageModel = {
  async *streamReply() {
    yield 'unused'
  }
}

function waitForTerminal(
  start: (emit: (event: ConversationEvent) => void) => Promise<unknown>
): Promise<ConversationEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ConversationEvent[] = []
    void start((event) => {
      events.push(event)
      if (['completed', 'failed', 'cancelled'].includes(event.type)) resolve(events)
    }).catch(reject)
  })
}

describe('vocabulary conversation integration', () => {
  it('persists the invocation, actual batch, and assistant reply in one conversation', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const conversationRepository = new SqliteConversationRepository(database)
    const vocabularyRepository = new SqliteVocabularyRepository(database)
    const analyze = vi.fn(async () => recognized())
    const describe = vi.fn(async () => 'The configured model described the result.')
    const skill = new VocabularyConversationSkill(vocabularyRepository, () => ({
      analyzer: { analyze },
      describer: { describe }
    }))
    const module = new ConversationModule(
      unusedConversationModel,
      conversationRepository,
      () => 'en',
      skill,
      conversationRepository
    )
    const { sessionId } = await module.createConversation()

    const events = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'vocabulary',
          arguments: { text: 'apple, banana, apple', wordLanguage: 'en' }
        },
        emit
      )
    )

    expect(events.map((event) => event.type)).toEqual([
      'started',
      'skillPhase',
      'skillPhase',
      'skillPhase',
      'completed'
    ])
    expect(vocabularyRepository.list({}).entries).toHaveLength(2)
    const loaded = await module.loadConversation(sessionId)
    expect(loaded.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(loaded.messages[0].content).toBe('/vocabulary apple, banana, apple')
    expect(loaded.messages[1].content).toContain('The configured model described the result.')
    expect(loaded.messages[1].content).toContain('2 added')

    const execution = await conversationRepository.findExecutionByUserMessage(
      sessionId,
      loaded.messages[0].messageId
    )
    expect(execution?.phase).toBe('completed')
    expect(execution?.batch?.counts).toMatchObject({ saved: 2, duplicate: 1 })
  })

  it('retries only the description after vocabulary has committed', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const conversationRepository = new SqliteConversationRepository(database)
    const vocabularyRepository = new SqliteVocabularyRepository(database)
    const analyze = vi.fn(async () => recognized())
    let descriptionAttempts = 0
    const skill = new VocabularyConversationSkill(vocabularyRepository, () => ({
      analyzer: { analyze },
      describer: {
        describe: async () => {
          descriptionAttempts += 1
          if (descriptionAttempts === 1) throw new Error('summary unavailable')
          return 'Description retry succeeded.'
        }
      }
    }))
    const module = new ConversationModule(
      unusedConversationModel,
      conversationRepository,
      () => 'en',
      skill,
      conversationRepository
    )
    const { sessionId } = await module.createConversation()
    const first = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'vocabulary',
          arguments: { text: 'apple', wordLanguage: 'en' }
        },
        emit
      )
    )
    const firstCompleted = first.at(-1)
    expect(firstCompleted).toMatchObject({
      type: 'completed',
      skillCompletion: 'description_failed'
    })
    const history = await module.loadConversation(sessionId)
    expect(history.messages[0].retryable).toBe(true)
    expect(analyze).toHaveBeenCalledTimes(1)

    const retry = await waitForTerminal((emit) =>
      module.retryMessage(
        {
          requestId: randomUUID(),
          sessionId,
          userMessageId: history.messages[0].messageId
        },
        emit
      )
    )
    expect(retry.at(-1)).toMatchObject({ type: 'completed', skillCompletion: 'complete' })
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(vocabularyRepository.list({}).entries).toHaveLength(1)
    const afterRetry = await module.loadConversation(sessionId)
    expect(afterRetry.messages.at(-1)?.content).toContain('Description retry succeeded.')
    expect(afterRetry.messages[0].retryable).toBeUndefined()
  })
})
