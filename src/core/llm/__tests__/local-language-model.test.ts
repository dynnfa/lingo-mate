import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { LocalLanguageModel } from '../local-language-model'

describe('LocalLanguageModel', () => {
  it('removes abort listeners after a streamed reply completes', async () => {
    const controller = new AbortController()
    const model = new LocalLanguageModel()
    const chunks: string[] = []

    for await (const delta of model.streamReply({
      messages: [{ role: 'user', content: 'Hello' }],
      outputLanguage: 'zh-CN',
      targetLanguage: 'en',
      signal: controller.signal
    })) {
      chunks.push(delta)
    }

    expect(chunks.length).toBeGreaterThan(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('removes the abort listener when a pending chunk is cancelled', async () => {
    const controller = new AbortController()
    const stream = new LocalLanguageModel()
      .streamReply({
        messages: [{ role: 'user', content: 'Hello' }],
        outputLanguage: 'zh-CN',
        targetLanguage: 'en',
        signal: controller.signal
      })
      [Symbol.asyncIterator]()

    const nextChunk = stream.next()
    controller.abort()

    await expect(nextChunk).rejects.toMatchObject({ name: 'AbortError' })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})
