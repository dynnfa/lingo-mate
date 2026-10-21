import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { LocalLanguageModel } from '../local-language-model'
import type { ModelStreamEvent } from '../language-model'

function input(
  purpose: 'conversation' | 'conversation-title' = 'conversation'
): Parameters<LocalLanguageModel['streamReply']>[0] {
  return {
    messages: [{ role: 'user' as const, content: 'Hello' }],
    systemPrompt: 'Explain in Simplified Chinese (zh-CN). Examples in English (en).',
    purpose,
    signal: new AbortController().signal
  }
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function textOf(events: ModelStreamEvent[]): string {
  return events
    .filter((event) => event.type === 'text')
    .map((event) => event.delta)
    .join('')
}

describe('LocalLanguageModel', () => {
  it('streams reasoning before the reply text and removes abort listeners afterwards', async () => {
    const controller = new AbortController()
    const events = await collect(new LocalLanguageModel().streamReply(input()))

    expect(events.length).toBeGreaterThan(0)
    // 思考先于正文：首个事件是 reasoning，最后一段是正文
    expect(events[0].type).toBe('reasoning')
    expect(events.at(-1)?.type).toBe('text')
    expect(textOf(events)).toContain('Hello')
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('returns only text events for title generation', async () => {
    const events = await collect(new LocalLanguageModel().streamReply(input('conversation-title')))

    expect(events.every((event) => event.type === 'text')).toBe(true)
    expect(textOf(events)).toBe('Hello')
  })

  it('removes the abort listener when a pending chunk is cancelled', async () => {
    const controller = new AbortController()
    const stream = new LocalLanguageModel()
      .streamReply({
        ...input(),
        signal: controller.signal
      })
      [Symbol.asyncIterator]()

    const nextChunk = stream.next()
    controller.abort()

    await expect(nextChunk).rejects.toMatchObject({ name: 'AbortError' })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})
