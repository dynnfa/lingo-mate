import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationEvent, ConversationSummary } from '../../../shared/conversation'
import { conversationEventSchema } from '../../../shared/conversation'
import type { LanguageModel, ModelStreamEvent, StreamReplyInput } from '../../llm/language-model'
import { ConfiguredLanguageModel } from '../../llm/configured-language-model'
import { ModelConfigService } from '../../llm/model-config'
import { LlmClient, type CreateLlmClient } from '../../llm/llm-client'
import { LlmUsageRecorder } from '../../llm/llm-usage-recorder'
import { ConversationModule, type ConversationLanguages } from '../conversation-module'
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

  async seedConversation(): Promise<ConversationSummary> {
    const now = new Date().toISOString()
    const conversation = {
      id: randomUUID(),
      title: 'Existing conversation',
      createdAt: now,
      updatedAt: now
    }
    await this.create(conversation)
    const { id, ...rest } = conversation
    return { sessionId: id, ...rest }
  }

  async create(conversation: StoredConversation): Promise<void> {
    this.conversations.push(conversation)
  }

  async updateTitle(sessionId: string, title: string): Promise<void> {
    const conversation = await this.find(sessionId)
    if (conversation) conversation.title = title
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

  async appendMessage(message: StoredMessage, conversation?: StoredConversation): Promise<void> {
    if (conversation) this.conversations.push(conversation)
    this.messages.push(message)
  }
}

const textEvent = (delta: string): ModelStreamEvent => ({ type: 'text', delta })
const reasoningEvent = (delta: string): ModelStreamEvent => ({ type: 'reasoning', delta })

class SuccessfulModel implements LanguageModel {
  async *streamReply(): AsyncIterable<ModelStreamEvent> {
    yield textEvent('Hi')
    yield textEvent(' there')
  }
}

// 迭代器第一次 next() 即抛错，模拟首 chunk 前的模型失败。
class ImmediateFailureModel implements LanguageModel {
  streamReply(): AsyncIterable<ModelStreamEvent> {
    const iterator: AsyncIterator<ModelStreamEvent> = {
      async next(): Promise<IteratorResult<ModelStreamEvent>> {
        throw new Error('model unavailable')
      }
    }
    return { [Symbol.asyncIterator]: () => iterator }
  }
}

class MidStreamFailureModel implements LanguageModel {
  async *streamReply(): AsyncIterable<ModelStreamEvent> {
    yield textEvent('par')
    yield textEvent('tial')
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

  async *streamReply({ signal }: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield textEvent('partial')
      await abortOnSignal(signal)
      return
    }
    yield textEvent('Hi there')
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

// 本用例在配置解密阶段失败，不会发起模型请求；工厂只需满足装配形状。
const unusedCreateClient: CreateLlmClient = (config) =>
  new LlmClient(
    config,
    new LlmUsageRecorder({
      insertStarted: () => {},
      finish: () => {},
      markInterruptedStarted: () => 0,
      list: () => []
    })
  )

describe('ConversationModule', () => {
  describe('conversation lifecycle', () => {
    it('creates a draft without writing or listing it', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)

      const summary = await module.createConversation()

      expect(summary.title).toBeNull()
      expect(repository.conversations).toEqual([])
      expect(await module.listConversations()).toEqual([])
      expect(await module.loadConversation(summary.sessionId)).toEqual({
        conversation: summary,
        messages: []
      })
    })

    it('lists conversations ordered by updatedAt, then createdAt, descending', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)

      const first = await repository.seedConversation()
      const second = await repository.seedConversation()

      // updatedAt 相同时，createdAt 较新的会话排在前面
      const secondAt = new Date(new Date(second.createdAt).getTime() + 60_000).toISOString()
      repository.conversations[1].createdAt = secondAt
      repository.conversations[1].updatedAt = secondAt

      expect(await module.listConversations()).toEqual([
        {
          sessionId: second.sessionId,
          title: second.title,
          createdAt: secondAt,
          updatedAt: secondAt
        },
        first
      ])

      // updatedAt 被刷新后重新排到最前
      const firstTouched = new Date(new Date(secondAt).getTime() + 60_000).toISOString()
      repository.conversations[0].updatedAt = firstTouched

      expect(await module.listConversations()).toEqual([
        {
          sessionId: first.sessionId,
          title: first.title,
          createdAt: first.createdAt,
          updatedAt: firstTouched
        },
        {
          sessionId: second.sessionId,
          title: second.title,
          createdAt: secondAt,
          updatedAt: secondAt
        }
      ])
    })

    it('loads a conversation with its history in stored order', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await repository.seedConversation()

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
        async updateTitle(sessionId: string, title: string): Promise<void> {
          const conversation = await this.find(sessionId)
          if (conversation) conversation.title = title
        }

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
      const { sessionId } = await repository.seedConversation()

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
      const { sessionId } = await repository.seedConversation()

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
            title: 'Existing conversation',
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
      const { sessionId } = await gatedRepository.seedConversation()

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

    it('fails before network access with a safe credential error when decryption breaks', async () => {
      const repository = new MemoryConversationRepository()
      const cause = new Error('private vault failure')
      const config = new ModelConfigService(
        {
          read: () => ({
            schemaVersion: 1,
            protocol: 'openai-compatible',
            baseUrl: 'https://model.invalid/v1',
            modelId: 'test',
            credential: 'encrypted'
          }),
          write: () => {}
        },
        {
          isAvailable: () => true,
          encrypt: () => 'encrypted',
          decrypt: () => {
            throw cause
          }
        },
        () => 'test-config-id'
      )
      const module = new ConversationModule(
        new ConfiguredLanguageModel(config, unusedCreateClient),
        repository
      )
      const { sessionId } = await repository.seedConversation()
      const events: ConversationEvent[] = []
      await module.sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) =>
        events.push(event)
      )
      await untilTerminal(events)
      expect(events.map((event) => event.type)).toEqual(['started', 'failed'])
      expect(events.at(-1)).toMatchObject({ error: { code: 'CREDENTIAL_DECRYPT_FAILED' } })
      expect(JSON.stringify(events)).not.toContain(cause.message)
      expect(repository.messages.map((message) => message.role)).toEqual(['user'])
    })

    it('records a background title failure while the reply still completes', async () => {
      const cause = new Error('title provider unavailable')
      const model: LanguageModel = {
        async *streamReply(input) {
          if (input.promptKind === 'conversation-title') throw cause
          yield textEvent('reply')
        }
      }
      const report = vi.fn()
      const module = new ConversationModule(
        model,
        new MemoryConversationRepository(),
        undefined,
        undefined,
        undefined,
        { report }
      )
      const { sessionId } = await module.createConversation()
      const events: ConversationEvent[] = []
      await module.sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) =>
        events.push(event)
      )
      await untilTerminal(events)
      expect(events.at(-1)?.type).toBe('completed')
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            operation: 'update-title',
            requestId: REQUEST_ID,
            error: expect.objectContaining({ cause })
          })
        )
      )
    })

    it.each([false, true])(
      'preserves failure terminal when diagnostics throws: %s',
      async (diagnosticsThrows) => {
        const repository = new MemoryConversationRepository()
        const report = vi.fn(() => {
          if (diagnosticsThrows) throw new Error('diagnostic unavailable')
        })
        const module = new ConversationModule(
          new ImmediateFailureModel(),
          repository,
          undefined,
          undefined,
          undefined,
          { report }
        )
        const { sessionId } = await repository.seedConversation()

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
        expect(report).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            module: 'conversation',
            operation: 'generate-reply',
            requestId: REQUEST_ID,
            error: expect.objectContaining({ message: 'model unavailable' })
          })
        )
        expect(JSON.stringify(events)).not.toContain('model unavailable')
        expect(repository.messages.map(({ role }) => role)).toEqual(['user'])
      }
    )

    it('fails with the assistant messageId after partial chunks and keeps only the user', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new MidStreamFailureModel(), repository)
      const { sessionId } = await repository.seedConversation()

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
            title: 'Existing conversation',
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
      const report = vi.fn()
      const module = new ConversationModule(
        new SuccessfulModel(),
        repository,
        undefined,
        undefined,
        undefined,
        { report }
      )

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
      expect(report).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'database details' })
        })
      )
    })

    it('cancels an active stream without persisting a partial assistant reply', async () => {
      const repository = new MemoryConversationRepository()
      const report = vi.fn()
      const module = new ConversationModule(
        new BlockingOnceModel(),
        repository,
        undefined,
        undefined,
        undefined,
        { report }
      )
      const { sessionId } = await repository.seedConversation()

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
      expect(report).not.toHaveBeenCalled()
    })

    it('cancels before model execution when requested as soon as the generation starts', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new SuccessfulModel(), repository)
      const { sessionId } = await repository.seedConversation()

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
      const firstConversation = await repository.seedConversation()
      const secondConversation = await repository.seedConversation()

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
      const { sessionId } = await repository.seedConversation()

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
      const firstConversation = await repository.seedConversation()
      const secondConversation = await repository.seedConversation()

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
      const { sessionId } = await repository.seedConversation()

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
      const { sessionId } = await repository.seedConversation()

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

  describe('reasoning stream separation', () => {
    class ReasoningModel implements LanguageModel {
      async *streamReply(input: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
        if (input.promptKind === 'conversation-title') {
          // 标题生成是纯正文消费者：即使提供方返回思考也应忽略。
          yield reasoningEvent('title thoughts must be ignored')
          yield textEvent('Coffee practice')
          return
        }
        yield reasoningEvent('思考第一段。')
        yield reasoningEvent('思考第二段。')
        yield textEvent('Hi')
        yield textEvent(' there')
      }
    }

    it('forwards reasoning deltas separately and keeps them out of the final message', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new ReasoningModel(), repository)
      const { sessionId } = await repository.seedConversation()

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

      expect(events.map((event) => event.type)).toEqual([
        'started',
        'reasoningChunk',
        'reasoningChunk',
        'chunk',
        'chunk',
        'completed'
      ])
      const started = events[0]
      if (started.type !== 'started') throw new Error('expected started event')
      const reasoningChunks = events.filter((event) => event.type === 'reasoningChunk')
      for (const chunk of reasoningChunks) {
        expect(chunk.messageId).toBe(started.assistantMessageId)
        // 事件载荷通过共享 schema 校验（reasoningChunk 属于合法事件协议）。
        expect(() => conversationEventSchema.parse(chunk)).not.toThrow()
      }

      // 思考只作临时展示：不进入最终消息、持久化历史与后续模型上下文。
      const completed = events.at(-1)
      if (completed?.type !== 'completed') throw new Error('expected completed event')
      expect(completed.message.content).toBe('Hi there')
      const persisted = repository.messages.find((message) => message.role === 'assistant')
      expect(persisted?.content).toBe('Hi there')
      expect(JSON.stringify(repository.messages)).not.toContain('思考第一段')
    })

    it('cancels during the reasoning phase without persisting anything', async () => {
      const repository = new MemoryConversationRepository()
      class ReasoningThenBlockModel implements LanguageModel {
        async *streamReply({ signal }: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
          yield reasoningEvent('思考中…')
          await abortOnSignal(signal)
        }
      }
      const module = new ConversationModule(new ReasoningThenBlockModel(), repository)
      const { sessionId } = await repository.seedConversation()

      const events = await new Promise<ConversationEvent[]>((resolve) => {
        const collected: ConversationEvent[] = []
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            collected.push(event)
            if (event.type === 'reasoningChunk') module.cancelMessage(REQUEST_ID)
            if (event.type === 'cancelled') resolve(collected)
          })
          .then(() => undefined)
      })

      expect(events.map((event) => event.type)).toEqual(['started', 'reasoningChunk', 'cancelled'])
      expect(repository.messages.map(({ role }) => role)).toEqual(['user'])
    })

    it('uses only text deltas for the background title generation', async () => {
      const repository = new MemoryConversationRepository()
      const module = new ConversationModule(new ReasoningModel(), repository)
      const summary = await module.createConversation()

      await new Promise<void>((resolve) => {
        void module
          .sendMessage(
            { requestId: REQUEST_ID, sessionId: summary.sessionId, text: 'Coffee' },
            () => undefined
          )
          .then(() => undefined)
        const interval = setInterval(() => {
          const conversation = repository.conversations.find(
            (candidate) => candidate.id === summary.sessionId
          )
          if (conversation?.title) {
            clearInterval(interval)
            resolve()
          }
        }, 5)
      })

      const conversation = repository.conversations.find(
        (candidate) => candidate.id === summary.sessionId
      )
      // 标题只由正文增量组成，思考增量被标题消费者忽略。
      expect(conversation?.title).toBe('Coffee practice')
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
      const { sessionId } = await repository.seedConversation()

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
      const { sessionId } = await repository.seedConversation()

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
      const { sessionId } = await repository.seedConversation()

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
      const { sessionId } = await repository.seedConversation()

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

  describe('word concept command', () => {
    class RecordingModel implements LanguageModel {
      readonly inputs: StreamReplyInput[] = []

      async *streamReply(input: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
        this.inputs.push(input)
        yield textEvent('解释')
      }
    }

    // 第一次调用产出首个 chunk 后挂起直到被取消；重试调用正常完成。
    class RecordingBlockingOnceModel implements LanguageModel {
      readonly inputs: StreamReplyInput[] = []
      private calls = 0

      async *streamReply(input: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
        this.inputs.push(input)
        this.calls += 1
        if (this.calls === 1) {
          yield textEvent('partial')
          await abortOnSignal(input.signal)
          return
        }
        yield textEvent('retried')
      }
    }

    async function sendUntilTerminal(
      module: ConversationModule,
      sessionId: string,
      text: string
    ): Promise<void> {
      await new Promise<void>((resolve) => {
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text }, (event) => {
            if (
              event.type === 'completed' ||
              event.type === 'failed' ||
              event.type === 'cancelled'
            ) {
              resolve()
            }
          })
          .then(() => undefined)
      })
    }

    it.each(['/concept pursue', ' /concept pursue '])(
      'answers %s with the word-concept prompt and the raw command text',
      async (text) => {
        const repository = new MemoryConversationRepository()
        const model = new RecordingModel()
        const module = new ConversationModule(model, repository)
        const { sessionId } = await repository.seedConversation()

        await sendUntilTerminal(module, sessionId, text)

        expect(model.inputs).toHaveLength(1)
        expect(model.inputs[0].promptKind).toBe('word-concept')
        // 原始命令消息保留在发给模型的上下文中，不额外改写或拼接
        expect(model.inputs[0].messages.at(-1)).toEqual({ role: 'user', content: text })
      }
    )

    it('keeps the conversation prompt for ordinary chat and follow-up questions', async () => {
      const repository = new MemoryConversationRepository()
      const model = new RecordingModel()
      const module = new ConversationModule(model, repository)
      const { sessionId } = await repository.seedConversation()

      await sendUntilTerminal(module, sessionId, 'Hello')
      await sendUntilTerminal(module, sessionId, '/concept pursue')
      await sendUntilTerminal(module, sessionId, '再举个例子')

      expect(model.inputs.map((input) => input.promptKind)).toEqual([
        'conversation',
        'word-concept',
        'conversation'
      ])
    })

    it.each(['/conceptual drift', 'What does /concept mean?'])(
      'does not treat %s as the command',
      async (text) => {
        const repository = new MemoryConversationRepository()
        const model = new RecordingModel()
        const module = new ConversationModule(model, repository)
        const { sessionId } = await repository.seedConversation()

        await sendUntilTerminal(module, sessionId, text)

        expect(model.inputs).toHaveLength(1)
        expect(model.inputs[0].promptKind).toBe('conversation')
      }
    )

    it('reapplies the word-concept prompt when retrying a cancelled /concept message', async () => {
      const repository = new MemoryConversationRepository()
      const model = new RecordingBlockingOnceModel()
      const module = new ConversationModule(model, repository)
      const { sessionId } = await repository.seedConversation()

      await new Promise<void>((resolve) => {
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: '/concept drift' }, (event) => {
            if (event.type === 'chunk') module.cancelMessage(REQUEST_ID)
            if (event.type === 'cancelled') resolve()
          })
          .then(() => undefined)
      })
      const user = repository.messages.find((message) => message.role === 'user')!

      await new Promise<void>((resolve) => {
        void module
          .retryMessage(
            { requestId: OTHER_REQUEST_ID, sessionId, userMessageId: user.id },
            (event) => {
              if (event.type === 'completed' || event.type === 'failed') resolve()
            }
          )
          .then(() => undefined)
      })

      expect(model.inputs.map((input) => input.promptKind)).toEqual([
        'word-concept',
        'word-concept'
      ])
    })
  })

  describe('language settings snapshot', () => {
    class RecordingModel implements LanguageModel {
      readonly inputs: StreamReplyInput[] = []

      async *streamReply(input: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
        this.inputs.push(input)
        yield textEvent('Hi')
      }
    }

    // 第一次调用产出首个 chunk 后挂起直到被取消；重试调用正常完成。
    class RecordingBlockingOnceModel implements LanguageModel {
      readonly inputs: StreamReplyInput[] = []
      private calls = 0

      async *streamReply(input: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
        this.inputs.push(input)
        this.calls += 1
        if (this.calls === 1) {
          yield textEvent('partial')
          await abortOnSignal(input.signal)
          return
        }
        yield textEvent('retried')
      }
    }

    // history() 在放行前挂起：在快照已建立、模型尚未调用之间制造可观察窗口。
    class GatedHistoryRepository extends MemoryConversationRepository {
      release?: () => void
      private readonly gate = new Promise<void>((resolve) => {
        this.release = resolve
      })

      async history(sessionId: string): Promise<StoredMessage[]> {
        await this.gate
        return super.history(sessionId)
      }
    }

    async function sendUntilTerminal(
      module: ConversationModule,
      sessionId: string,
      text: string
    ): Promise<void> {
      await new Promise<void>((resolve) => {
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text }, (event) => {
            if (
              event.type === 'completed' ||
              event.type === 'failed' ||
              event.type === 'cancelled'
            ) {
              resolve()
            }
          })
          .then(() => undefined)
      })
    }

    it('sends the resolved output and target languages to the model', async () => {
      const repository = new MemoryConversationRepository()
      const model = new RecordingModel()
      const settings: ConversationLanguages = {
        outputLanguage: 'zh-CN',
        targetLanguage: 'en'
      }
      const module = new ConversationModule(model, repository, () => settings)
      const { sessionId } = await repository.seedConversation()

      await sendUntilTerminal(module, sessionId, 'Hello')
      expect(model.inputs[0]).toMatchObject({
        outputLanguage: 'zh-CN',
        targetLanguage: 'en'
      })

      // 界面语言变化只影响解释语言，目标语言保持来自同一份设置
      settings.outputLanguage = 'en'
      await sendUntilTerminal(module, sessionId, 'Again')
      expect(model.inputs[1]).toMatchObject({
        outputLanguage: 'en',
        targetLanguage: 'en'
      })
    })

    it('keeps the snapshot for an in-flight execution when settings change', async () => {
      const repository = new GatedHistoryRepository()
      const model = new RecordingModel()
      const settings: ConversationLanguages = {
        outputLanguage: 'zh-CN',
        targetLanguage: 'en'
      }
      const module = new ConversationModule(model, repository, () => settings)
      const { sessionId } = await repository.seedConversation()

      const terminal = new Promise<void>((resolve) => {
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            if (event.type === 'completed' || event.type === 'failed') resolve()
          })
          .then(() => undefined)
      })
      // user 消息落库即代表快照已建立（registerExecution 先于 appendMessage）；
      // 此时 runGeneration 挂起在尚未放行的 history() 上。
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (repository.messages.some((message) => message.role === 'user')) {
            clearInterval(timer)
            resolve()
          }
        }, 5)
      })
      settings.outputLanguage = 'en'
      repository.release?.()

      await terminal
      // 设置变更不影响在途请求：模型仍收到执行开始时的语言快照
      expect(model.inputs[0]).toMatchObject({ outputLanguage: 'zh-CN' })
    })

    it('re-reads the current settings when an ordinary reply is retried', async () => {
      const repository = new MemoryConversationRepository()
      const model = new RecordingBlockingOnceModel()
      const settings: ConversationLanguages = {
        outputLanguage: 'zh-CN',
        targetLanguage: 'en'
      }
      const module = new ConversationModule(model, repository, () => settings)
      const { sessionId } = await repository.seedConversation()

      await new Promise<void>((resolve) => {
        void module
          .sendMessage({ requestId: REQUEST_ID, sessionId, text: 'Hello' }, (event) => {
            if (event.type === 'chunk') module.cancelMessage(REQUEST_ID)
            if (event.type === 'cancelled') resolve()
          })
          .then(() => undefined)
      })
      const user = repository.messages.find((message) => message.role === 'user')!

      settings.outputLanguage = 'en'
      await new Promise<void>((resolve) => {
        void module
          .retryMessage(
            { requestId: OTHER_REQUEST_ID, sessionId, userMessageId: user.id },
            (event) => {
              if (event.type === 'completed' || event.type === 'failed') resolve()
            }
          )
          .then(() => undefined)
      })

      // 普通回复重试作为新执行读取当前设置
      expect(model.inputs[0]).toMatchObject({ outputLanguage: 'zh-CN' })
      expect(model.inputs[1]).toMatchObject({ outputLanguage: 'en' })
    })
  })
})
