import { describe, expect, it } from 'vitest'
import type { ConversationEvent } from '../../../shared/conversation'
import type { LanguageModel, StreamReplyInput } from '../../llm/language-model'
import { ConversationModule } from '../conversation-module'
import {
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationPersistenceError,
  MessageNotFoundError,
  RequestBusyError,
  RequestNotFoundError,
  RetryNotAllowedError,
  type ConversationRepository,
  type StoredConversation,
  type StoredMessage
} from '../conversation-repository'

const REQUEST_ID = '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708'
const OTHER_REQUEST_ID = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'

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

// 迭代器第一次 next() 即抛错，模拟首 chunk 前的模型失败。
class ImmediateFailureModel implements LanguageModel {
  streamReply(): AsyncIterable<string> {
    const iterator: AsyncIterator<string> = {
      async next(): Promise<IteratorResult<string>> {
        throw new Error('model unavailable')
      }
    }
    return { [Symbol.asyncIterator]: () => iterator }
  }
}

class MidStreamFailureModel implements LanguageModel {
  async *streamReply(): AsyncIterable<string> {
    yield 'par'
    yield 'tial'
    throw new Error('model crashed mid-stream')
  }
}

function abortOnSignal(signal: AbortSignal): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'))
      return
    }
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('The operation was aborted', 'AbortError')),
      { once: true }
    )
  })
}

// 第一次调用产出首个 chunk 后挂起直到被取消；之后的调用正常完成。
// 这样可以先制造一次"取消"，再对同一条 user 消息验证 retry。
class BlockingOnceModel implements LanguageModel {
  private calls = 0

  async *streamReply({ signal }: StreamReplyInput): AsyncIterable<string> {
    this.calls += 1
    if (this.calls === 1) {
      yield 'partial'
      await abortOnSignal(signal)
      return
    }
    yield 'Hi there'
  }
}

// 等待事件流中出现首个终态事件。
function untilTerminal(collected: ConversationEvent[]): Promise<ConversationEvent[]> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const terminal = collected.find(
        (event) =>
          event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled'
      )
      if (terminal) {
        clearInterval(interval)
        resolve(collected)
      }
    }, 5)
  })
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
        {
          messageId: 'm1',
          sessionId,
          role: 'user',
          content: 'Hello',
          createdAt: '2026-09-01T10:00:00.000Z'
        },
        {
          messageId: 'm2',
          sessionId,
          role: 'assistant',
          content: 'Hi',
          createdAt: '2026-09-01T10:00:01.000Z'
        }
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

  describe('message generation identity', () => {
    it('uses one canonical assistant messageId across started, chunks, completion and storage', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await module.createConversation()

      const events = await new Promise<ConversationEvent[]>((resolve) => {
        const collected: ConversationEvent[] = []
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            collected.push(event)
            if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled')
              resolve(collected)
          })
          .then(() => undefined)
      })

      expect(events.map((event) => event.type)).toEqual(['started', 'chunk', 'chunk', 'completed'])

      const started = events[0]
      if (started.type !== 'started') throw new Error('expected started event')
      const chunks = events.filter((event) => event.type === 'chunk')
      for (const chunk of chunks) {
        expect(chunk.messageId).toBe(started.assistantMessageId)
      }
      const completed = events.at(-1)
      if (completed?.type !== 'completed') throw new Error('expected completed event')

      const persistedUser = repository.messages.find((message) => message.role === 'user')
      const persistedAssistant = repository.messages.find((message) => message.role === 'assistant')
      expect(started.userMessage.messageId).toBe(persistedUser?.id)
      expect(completed.message.messageId).toBe(started.assistantMessageId)
      expect(persistedAssistant?.id).toBe(started.assistantMessageId)
      expect(completed.message.content).toBe('Hi there')
      expect(persistedAssistant?.content).toBe('Hi there')
    })

    it('returns the canonical generation payload from the accepted send result', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await module.createConversation()

      const events: ConversationEvent[] = []
      const result = await module.sendMessage(
        { requestId: REQUEST_ID, sessionId, text: 'Hello' },
        (event) => events.push(event)
      )

      expect(result.accepted).toBe(true)
      const persistedUser = repository.messages.find((message) => message.role === 'user')
      expect(result.generation.userMessage.messageId).toBe(persistedUser?.id)
      expect(result.generation.requestId).toBe(REQUEST_ID)

      // run() 在结果返回后继续，最终恰好产生一个终态事件
      await untilTerminal(events)
      expect(events.at(-1)?.type).toBe('completed')
    })

    it('rejects sending to an unknown conversation without persisting anything', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)

      await expect(
        module.sendMessage(
          {
            requestId: REQUEST_ID,
            sessionId: 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477',
            text: 'Hello'
          },
          () => undefined
        )
      ).rejects.toThrow(ConversationNotFoundError)
      expect(repository.messages).toHaveLength(0)
    })

    it('fails without a messageId and emits no started when the user append fails', async () => {
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
      const repository = new FailingAppendRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const events: ConversationEvent[] = []

      await expect(
        module.sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) =>
          events.push(event)
        )
      ).rejects.toThrow(ConversationPersistenceError)

      expect(events).toEqual([
        {
          type: 'failed',
          requestId: REQUEST_ID,
          sessionId,
          error: { code: 'PERSISTENCE_ERROR' }
        }
      ])
      expect(repository.messages).toHaveLength(0)
    })

    it('emits started then cancelled when cancellation lands during the user append', async () => {
      let openGate!: () => void
      const gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
      let signalAppend!: () => void
      const appendEntered = new Promise<void>((resolve) => {
        signalAppend = resolve
      })
      class GatedUserAppendRepository extends MemoryConversationRepository {
        override async appendMessage(message: StoredMessage): Promise<void> {
          if (message.role === 'user') {
            signalAppend()
            await gate
          }
          return super.appendMessage(message)
        }
      }
      const gatedRepository = new GatedUserAppendRepository()
      const module = new ConversationModule(new SuccessfulModel(), gatedRepository)
      const { sessionId } = await module.createConversation()

      const events: ConversationEvent[] = []
      const sendPromise = module.sendMessage(
        { requestId: REQUEST_ID, sessionId, text: 'Hello' },
        (event) => events.push(event)
      )

      await appendEntered
      module.cancelMessage(REQUEST_ID)
      openGate()

      const result = await sendPromise
      expect(result.accepted).toBe(true)

      await untilTerminal(events)

      expect(events.map((event) => event.type)).toEqual(['started', 'cancelled'])
      const cancelled = events.at(-1)
      if (cancelled?.type !== 'cancelled') throw new Error('expected cancelled event')
      const started = events[0]
      if (started.type !== 'started') throw new Error('expected started event')
      expect(cancelled.messageId).toBe(started.assistantMessageId)
      expect(gatedRepository.messages).toHaveLength(1)
      expect(gatedRepository.messages[0].role).toBe('user')
    })

    it('fails with the assistant messageId and keeps only the user when the model fails before chunks', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new ImmediateFailureModel(), repository)
      const { sessionId } = await module.createConversation()

      const events = await new Promise<ConversationEvent[]>((resolve) => {
        const collected: ConversationEvent[] = []
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            collected.push(event)
            if (event.type === 'failed') resolve(collected)
          })
          .then(() => undefined)
      })

      const started = events[0]
      const failed = events.at(-1)
      if (started?.type !== 'started' || failed?.type !== 'failed') {
        throw new Error('unexpected event sequence')
      }
      expect(events.map((event) => event.type)).toEqual(['started', 'failed'])
      expect(failed.messageId).toBe(started.assistantMessageId)
      expect(failed.error).toEqual({ code: 'MODEL_ERROR' })
      expect(repository.messages.map(({ role }) => role)).toEqual(['user'])
    })

    it('fails with the assistant messageId after partial chunks and keeps only the user', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new MidStreamFailureModel(), repository)
      const { sessionId } = await module.createConversation()

      const events = await new Promise<ConversationEvent[]>((resolve) => {
        const collected: ConversationEvent[] = []
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            collected.push(event)
            if (event.type === 'failed') resolve(collected)
          })
          .then(() => undefined)
      })

      expect(events.map((event) => event.type)).toEqual(['started', 'chunk', 'chunk', 'failed'])
      const started = events[0]
      const failed = events.at(-1)
      if (started?.type !== 'started' || failed?.type !== 'failed') {
        throw new Error('unexpected event sequence')
      }
      expect(failed.messageId).toBe(started.assistantMessageId)
      expect(repository.messages.map(({ role }) => role)).toEqual(['user'])
    })

    it('fails with a persistence error and does not persist a draft when the assistant append fails', async () => {
      const sessionId = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'
      class FailingAssistantAppendRepository extends MemoryConversationRepository {
        override async find(): Promise<StoredConversation | undefined> {
          return {
            id: sessionId,
            createdAt: '2026-09-01T10:00:00.000Z',
            updatedAt: '2026-09-01T10:00:00.000Z'
          }
        }

        override async appendMessage(message: StoredMessage): Promise<void> {
          if (message.role === 'assistant') {
            throw new ConversationPersistenceError('database details')
          }
          return super.appendMessage(message)
        }
      }
      const repository = new FailingAssistantAppendRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)

      const events = await new Promise<ConversationEvent[]>((resolve) => {
        const collected: ConversationEvent[] = []
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            collected.push(event)
            if (event.type === 'failed') resolve(collected)
          })
          .then(() => undefined)
      })

      const started = events[0]
      const failed = events.at(-1)
      if (started?.type !== 'started' || failed?.type !== 'failed') {
        throw new Error('unexpected event sequence')
      }
      expect(failed.messageId).toBe(started.assistantMessageId)
      expect(failed.error.code).toBe('PERSISTENCE_ERROR')
      expect(repository.messages.map(({ role }) => role)).toEqual(['user'])
    })

    it('cancels an active stream without persisting a partial assistant reply', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new BlockingOnceModel(), repository)
      const { sessionId } = await module.createConversation()

      const events = await new Promise<ConversationEvent[]>((resolve) => {
        const collected: ConversationEvent[] = []
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            collected.push(event)
            if (event.type === 'chunk') module.cancelMessage(REQUEST_ID)
            if (event.type === 'cancelled') resolve(collected)
          })
          .then(() => undefined)
      })

      expect(events.map((event) => event.type)).toEqual(['started', 'chunk', 'cancelled'])
      const started = events[0]
      const cancelled = events.at(-1)
      if (started?.type !== 'started' || cancelled?.type !== 'cancelled') {
        throw new Error('unexpected event sequence')
      }
      expect(cancelled.messageId).toBe(started.assistantMessageId)
      expect(repository.messages).toHaveLength(1)
      expect(repository.messages[0].role).toBe('user')
    })

    it('cancels before model execution when requested as soon as the generation starts', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await module.createConversation()

      const events = await new Promise<ConversationEvent[]>((resolve) => {
        const collected: ConversationEvent[] = []
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            collected.push(event)
            if (event.type === 'started') module.cancelMessage(REQUEST_ID)
            if (event.type === 'cancelled') resolve(collected)
          })
          .then(() => undefined)
      })

      expect(events.map((event) => event.type)).toEqual(['started', 'cancelled'])
      expect(repository.messages).toHaveLength(1)
    })
  })

  describe('session concurrency', () => {
    it('rejects reusing an active request id across different sessions', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new BlockingOnceModel(), repository)
      const firstConversation = await module.createConversation()
      const secondConversation = await module.createConversation()

      const firstEvents: ConversationEvent[] = []
      await module.sendMessage(
        { requestId: REQUEST_ID, sessionId: firstConversation.sessionId, text: 'Hello' },
        (event) => firstEvents.push(event)
      )

      await expect(
        module.sendMessage(
          { requestId: REQUEST_ID, sessionId: secondConversation.sessionId, text: 'Bonjour' },
          () => undefined
        )
      ).rejects.toThrow(RequestBusyError)

      expect(repository.messages).toHaveLength(1)
      module.cancelMessage(REQUEST_ID)
      await untilTerminal(firstEvents)
    })

    it('rejects a second send to the same session with a typed busy error', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new BlockingOnceModel(), repository)
      const { sessionId } = await module.createConversation()

      const firstEvents: ConversationEvent[] = []
      const first = module.sendMessage(
        { requestId: REQUEST_ID, sessionId, text: 'Hello' },
        (event) => firstEvents.push(event)
      )
      await expect(first).resolves.toMatchObject({ accepted: true })

      await expect(
        module.sendMessage(
          { requestId: OTHER_REQUEST_ID, sessionId, text: 'Hello again' },
          () => undefined
        )
      ).rejects.toThrow(ConversationBusyError)

      // 拒绝的请求没有留下任何持久化痕迹；会话仍只有一条 user 消息
      expect(repository.messages).toHaveLength(1)

      module.cancelMessage(REQUEST_ID)
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (firstEvents.some((event) => event.type === 'cancelled')) {
            clearInterval(interval)
            resolve()
          }
        }, 5)
      })
    })

    it('allows parallel generations across different sessions', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const firstConversation = await module.createConversation()
      const secondConversation = await module.createConversation()

      const firstTerminal = new Promise<void>((resolve) => {
        void module
          .sendMessage(
            { requestId: REQUEST_ID, sessionId: firstConversation.sessionId, text: 'Hello' },
            (event) => {
              if (event.type === 'completed') resolve()
            }
          )
          .then(() => undefined)
      })
      const secondTerminal = new Promise<void>((resolve) => {
        void module
          .sendMessage(
            { requestId: OTHER_REQUEST_ID, sessionId: secondConversation.sessionId, text: 'Hello' },
            (event) => {
              if (event.type === 'completed') resolve()
            }
          )
          .then(() => undefined)
      })

      await Promise.all([firstTerminal, secondTerminal])

      expect(repository.messages).toHaveLength(4)
      expect(repository.messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
    })

    it('frees the session for a new generation after a terminal event', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await module.createConversation()

      await new Promise<void>((resolve) => {
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            if (event.type === 'completed') resolve()
          })
          .then(() => undefined)
      })

      await expect(
        module.sendMessage(
          { requestId: OTHER_REQUEST_ID, sessionId, text: 'Hello again' },
          () => undefined
        )
      ).resolves.toMatchObject({ accepted: true })
    })

    it('throws a typed error when cancelling an unknown or finished request', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await module.createConversation()

      expect(() => module.cancelMessage(REQUEST_ID)).toThrow(RequestNotFoundError)

      await new Promise<void>((resolve) => {
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            if (event.type === 'completed') resolve()
          })
          .then(() => undefined)
      })

      expect(() => module.cancelMessage(REQUEST_ID)).toThrow(RequestNotFoundError)
    })
  })

  describe('retry', () => {
    async function cancelAfterFirstChunk(
      module: ConversationModule,
      sessionId: string,
      text = 'Hello'
    ): Promise<void> {
      await new Promise<void>((resolve) => {
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text }, (event) => {
            if (event.type === 'chunk') module.cancelMessage(REQUEST_ID)
            if (event.type === 'cancelled') resolve()
          })
          .then(() => undefined)
      })
    }

    it('retries the last unanswered user message without duplicating it', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new BlockingOnceModel(), repository)
      const { sessionId } = await module.createConversation()

      await cancelAfterFirstChunk(module, sessionId)
      const originalUser = repository.messages.find((message) => message.role === 'user')

      const events = await new Promise<ConversationEvent[]>((resolve) => {
        const collected: ConversationEvent[] = []
        void module
          .retryMessage(
            { requestId: OTHER_REQUEST_ID, sessionId, userMessageId: originalUser!.id },
            (event) => {
              collected.push(event)
              if (event.type === 'completed' || event.type === 'failed') resolve(collected)
            }
          )
          .then(() => undefined)
      })

      const started = events[0]
      const completed = events.at(-1)
      if (started?.type !== 'started' || completed?.type !== 'completed') {
        throw new Error('unexpected event sequence')
      }

      // 不重复写入 user；assistant 使用新的 canonical ID
      expect(repository.messages).toHaveLength(2)
      expect(started.userMessage.messageId).toBe(originalUser!.id)
      const assistant = repository.messages.find((message) => message.role === 'assistant')
      expect(assistant?.id).toBe(started.assistantMessageId)
      expect(completed.message.messageId).toBe(started.assistantMessageId)
    })

    it('rejects retrying a user message that already has an assistant reply', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await module.createConversation()

      await new Promise<void>((resolve) => {
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            if (event.type === 'completed') resolve()
          })
          .then(() => undefined)
      })
      const user = repository.messages.find((message) => message.role === 'user')!

      await expect(
        module.retryMessage(
          { requestId: OTHER_REQUEST_ID, sessionId, userMessageId: user.id },
          () => undefined
        )
      ).rejects.toThrow(RetryNotAllowedError)
      expect(repository.messages).toHaveLength(2)
    })

    it('rejects retrying an unknown message or a non-user message', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await module.createConversation()

      await new Promise<void>((resolve) => {
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            if (event.type === 'completed') resolve()
          })
          .then(() => undefined)
      })
      const assistant = repository.messages.find((message) => message.role === 'assistant')!

      await expect(
        module.retryMessage(
          {
            requestId: OTHER_REQUEST_ID,
            sessionId,
            userMessageId: '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5'
          },
          () => undefined
        )
      ).rejects.toThrow(MessageNotFoundError)

      await expect(
        module.retryMessage(
          { requestId: OTHER_REQUEST_ID, sessionId, userMessageId: assistant.id },
          () => undefined
        )
      ).rejects.toThrow(MessageNotFoundError)
    })

    it('rejects retry while another generation is active in the session', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new BlockingOnceModel(), repository)
      const { sessionId } = await module.createConversation()

      await module.sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, () => undefined)
      const user = repository.messages.find((message) => message.role === 'user')!

      await expect(
        module.retryMessage(
          { requestId: OTHER_REQUEST_ID, sessionId, userMessageId: user.id },
          () => undefined
        )
      ).rejects.toThrow(ConversationBusyError)

      module.cancelMessage(REQUEST_ID)
    })

    it('rejects retrying in an unknown conversation', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)

      await expect(
        module.retryMessage(
          {
            requestId: REQUEST_ID,
            sessionId: 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477',
            userMessageId: '6a9ee8b8-83aa-4b52-8d5a-91f0a48e26f5'
          },
          () => undefined
        )
      ).rejects.toThrow(ConversationNotFoundError)
    })
  })
})
