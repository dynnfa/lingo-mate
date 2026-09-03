import { describe, expect, it } from 'vitest'
import type { ConversationEvent, SendMessageInput } from '../../shared/conversation'
import type { LanguageModel, StreamReplyInput } from '../llm/language-model'
import {
  ConversationPersistenceError,
  ConversationSession,
  type ConversationStore,
  type StoredMessage
} from './conversation-session'

const input: SendMessageInput = {
  requestId: '3f70b8ae-7ad9-4eab-aaf4-1cae54a99708',
  sessionId: 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477',
  text: 'Hello'
}

class MemoryConversationStore implements ConversationStore {
  readonly messages: StoredMessage[] = []

  async append(message: StoredMessage): Promise<void> {
    this.messages.push(message)
  }

  async history(sessionId: string): Promise<StoredMessage[]> {
    return this.messages.filter((message) => message.sessionId === sessionId)
  }
}

class SuccessfulModel implements LanguageModel {
  async *streamReply(): AsyncIterable<string> {
    yield 'Hi'
    yield ' there'
  }
}

const runUntilTerminal = (
  session: ConversationSession,
  onStarted?: () => void
): Promise<ConversationEvent[]> =>
  new Promise((resolve) => {
    const events: ConversationEvent[] = []

    session.start(input, (event) => {
      events.push(event)
      if (event.type === 'started') onStarted?.()
      if (['completed', 'failed', 'cancelled'].includes(event.type)) resolve(events)
    })
  })

describe('ConversationSession', () => {
  it('streams a reply and persists both sides of a completed conversation', async () => {
    const store = new MemoryConversationStore()
    const events = await runUntilTerminal(new ConversationSession(new SuccessfulModel(), store))

    expect(events.map((event) => event.type)).toEqual(['started', 'chunk', 'chunk', 'completed'])
    expect(store.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' }
    ])
  })

  it('emits a safe failure when persistence fails', async () => {
    const store: ConversationStore = {
      async append() {
        throw new ConversationPersistenceError('database details')
      },
      async history() {
        return []
      }
    }

    const events = await runUntilTerminal(new ConversationSession(new SuccessfulModel(), store))

    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      error: { code: 'PERSISTENCE_ERROR', message: '保存会话失败，请稍后重试。' }
    })
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

    const store = new MemoryConversationStore()
    const session = new ConversationSession(new WaitingModel(), store)
    const eventsPromise = new Promise<ConversationEvent[]>((resolve) => {
      const events: ConversationEvent[] = []
      session.start(input, (event) => {
        events.push(event)
        if (event.type === 'chunk') session.cancel(input.requestId)
        if (event.type === 'cancelled') resolve(events)
      })
    })

    const events = await eventsPromise

    expect(events.map((event) => event.type)).toEqual(['started', 'chunk', 'cancelled'])
    expect(store.messages).toHaveLength(1)
    expect(store.messages[0].role).toBe('user')
  })

  it('cancels before model execution when requested as soon as the session starts', async () => {
    const store = new MemoryConversationStore()
    const session = new ConversationSession(new SuccessfulModel(), store)
    const events = await runUntilTerminal(session, () => session.cancel(input.requestId))

    expect(events.map((event) => event.type)).toEqual(['started', 'cancelled'])
    expect(store.messages).toHaveLength(1)
  })
})
