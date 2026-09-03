import { describe, expect, it } from 'vitest'
import type { ConversationEvent } from '../../shared/conversation'
import type { LanguageModel, StreamReplyInput } from '../llm/language-model'
import { ConversationModule } from './conversation-module'
import {
  ConversationNotFoundError,
  ConversationPersistenceError,
  type ConversationRepository,
  type StoredConversation,
  type StoredMessage
} from './conversation-repository'

class MemoryConversationRepository implements ConversationRepository {
  readonly conversations: StoredConversation[] = []
  readonly messages: StoredMessage[] = []

  async create(conversation: StoredConversation): Promise<void> {
    this.conversations.push(conversation)
  }

  async list(): Promise<StoredConversation[]> {
    return [...this.conversations]
  }

  async find(sessionId: string): Promise<StoredConversation | undefined> {
    return this.conversations.find((conversation) => conversation.id === sessionId)
  }

  async history(sessionId: string): Promise<StoredMessage[]> {
    return this.messages.filter((message) => message.sessionId === sessionId)
  }

  async appendMessage(message: StoredMessage): Promise<void> {
    this.messages.push(message)
  }
}

class SuccessfulModel implements LanguageModel {
  async *streamReply(): AsyncIterable<string> {
    yield 'Hi'
    yield ' there'
  }
}

describe('ConversationModule', () => {
  describe('conversation lifecycle', () => {
    it('creates a conversation that is persisted and listed', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)

      const summary = await module.createConversation()

      expect(summary.sessionId).toBe(repository.conversations[0].id)
      expect(summary.createdAt).toBe(repository.conversations[0].createdAt)
      expect(await module.listConversations()).toEqual([summary])
    })

    it('lists conversations ordered by updatedAt, then createdAt, descending', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)

      const first = await module.createConversation()
      const second = await module.createConversation()

      // updatedAt 相同时，createdAt 较新的会话排在前面
      const secondAt = new Date(new Date(second.createdAt).getTime() + 60_000).toISOString()
      repository.conversations[1].createdAt = secondAt
      repository.conversations[1].updatedAt = secondAt

      expect(await module.listConversations()).toEqual([
        { sessionId: second.sessionId, createdAt: secondAt, updatedAt: secondAt },
        first
      ])

      // updatedAt 被刷新后重新排到最前
      const firstTouched = new Date(new Date(secondAt).getTime() + 60_000).toISOString()
      repository.conversations[0].updatedAt = firstTouched

      expect(await module.listConversations()).toEqual([
        { sessionId: first.sessionId, createdAt: first.createdAt, updatedAt: firstTouched },
        { sessionId: second.sessionId, createdAt: secondAt, updatedAt: secondAt }
      ])
    })

    it('loads a conversation with its history in stored order', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await module.createConversation()

      repository.messages.push(
        {
          id: 'm1',
          sessionId,
          role: 'user',
          content: 'Hello',
          createdAt: '2026-09-01T10:00:00.000Z'
        },
        {
          id: 'm2',
          sessionId,
          role: 'assistant',
          content: 'Hi',
          createdAt: '2026-09-01T10:00:01.000Z'
        }
      )

      const loaded = await module.loadConversation(sessionId)

      expect(loaded.conversation.sessionId).toBe(sessionId)
      expect(loaded.messages).toEqual([
        { id: 'm1', role: 'user', content: 'Hello', createdAt: '2026-09-01T10:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'Hi', createdAt: '2026-09-01T10:00:01.000Z' }
      ])
    })

    it('throws a typed error when loading an unknown conversation', async () => {
      const module = new ConversationModule(
        new SuccessfulModel(),
        new MemoryConversationRepository()
      )

      await expect(module.loadConversation('f9364f0f-f3f4-4ea6-a31d-b55754aa2477')).rejects.toThrow(
        ConversationNotFoundError
      )
    })

    it('wraps unexpected repository failures as persistence errors', async () => {
      class FailingListRepository extends MemoryConversationRepository {
        async list(): Promise<StoredConversation[]> {
          throw new Error('raw driver failure')
        }
      }
      const module = new ConversationModule(new SuccessfulModel(), new FailingListRepository())

      await expect(module.listConversations()).rejects.toThrow(ConversationPersistenceError)
    })
  })

  describe('message generation', () => {
    const runUntilTerminal = (
      module: ConversationModule,
      sessionId: string,
      onStarted?: () => void
    ): Promise<ConversationEvent[]> =>
      new Promise((resolve) => {
        const events: ConversationEvent[] = []

        void module
          .sendMessage(
            { requestId: '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708', sessionId, text: 'Hello' },
            (event) => {
              events.push(event)
              if (event.type === 'started') onStarted?.()
              if (['completed', 'failed', 'cancelled'].includes(event.type)) resolve(events)
            }
          )
          .then(() => undefined)
      })

    it('streams a reply and persists both sides of a completed conversation', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await module.createConversation()

      const events = await runUntilTerminal(module, sessionId)

      expect(events.map((event) => event.type)).toEqual(['started', 'chunk', 'chunk', 'completed'])
      expect(repository.messages.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' }
      ])
    })

    it('emits a safe failure when persistence fails', async () => {
      const sessionId = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
      class FailingAppendRepository extends MemoryConversationRepository {
        override async find(): Promise<StoredConversation | undefined> {
          return {
            id: sessionId,
            createdAt: '2026-09-01T10:00:00.000Z',
            updatedAt: '2026-09-01T10:00:00.000Z'
          }
        }

        override async appendMessage(): Promise<void> {
          throw new ConversationPersistenceError('database details')
        }
      }
      const module = new ConversationModule(new SuccessfulModel(), new FailingAppendRepository())

      const events = await runUntilTerminal(module, sessionId)

      expect(events.at(-1)).toMatchObject({
        type: 'failed',
        error: { code: 'PERSISTENCE_ERROR', message: '保存会话失败，请稍后重试。' }
      })
    })

    it('rejects sending to an unknown conversation without persisting anything', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)

      await expect(
        module.sendMessage(
          {
            requestId: '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708',
            sessionId: 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477',
            text: 'Hello'
          },
          () => undefined
        )
      ).rejects.toThrow(ConversationNotFoundError)
      expect(repository.messages).toHaveLength(0)
    })

    it('cancels an active stream without persisting a partial assistant reply', async () => {
      class WaitingModel implements LanguageModel {
        async *streamReply({ signal }: StreamReplyInput): AsyncIterable<string> {
          yield 'partial'
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('The operation was aborted', 'AbortError')),
              { once: true }
            )
          })
        }
      }

      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new WaitingModel(), repository)
      const { sessionId } = await module.createConversation()
      const eventsPromise = new Promise<ConversationEvent[]>((resolve) => {
        const events: ConversationEvent[] = []
        void module
          .sendMessage(
            { requestId: '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708', sessionId, text: 'Hello' },
            (event) => {
              events.push(event)
              if (event.type === 'chunk')
                module.cancelMessage('3f70b8ae-7ad9-4eab-aaf4-1cae54a99708')
              if (event.type === 'cancelled') resolve(events)
            }
          )
          .then(() => undefined)
      })

      const events = await eventsPromise

      expect(events.map((event) => event.type)).toEqual(['started', 'chunk', 'cancelled'])
      expect(repository.messages).toHaveLength(1)
      expect(repository.messages[0].role).toBe('user')
    })

    it('cancels before model execution when requested as soon as the request starts', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await module.createConversation()

      const events = await runUntilTerminal(module, sessionId, () =>
        module.cancelMessage('3f70b8ae-7ad9-4eab-aaf4-1cae54a99708')
      )

      expect(events.map((event) => event.type)).toEqual(['started', 'cancelled'])
      expect(repository.messages).toHaveLength(1)
    })
  })
})
