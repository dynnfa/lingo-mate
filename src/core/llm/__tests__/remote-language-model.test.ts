import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteLanguageModel } from '../remote-language-model'

const CONFIG = {
  configured: true as const,
  protocol: 'openai-compatible' as const,
  baseUrl: 'https://model.invalid/v1',
  modelId: 'test-model',
  apiKey: undefined
}
const encoder = new TextEncoder()
const event = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const chunk = (content: string | null, finishReason: string | null = null): string =>
  event({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })
const STOP = chunk(null, 'stop')
const DONE = 'data: [DONE]\n\n'

function reply(signal = new AbortController().signal, timeoutMs = 1_000): AsyncGenerator<string> {
  return new RemoteLanguageModel(CONFIG, timeoutMs).streamReply({
    messages: [{ role: 'user', content: 'Help me practice English.' }],
    outputLanguage: 'zh-CN',
    targetLanguage: 'en',
    signal
  })
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function respond(body: string, contentType = 'text/event-stream'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(body, {
          headers: { 'content-type': contentType }
        })
    )
  )
}

function stallAfterFirstChunk(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url: unknown, init: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(chunk('first')))
              init.signal?.addEventListener(
                'abort',
                () => {
                  controller.error(new DOMException('Aborted', 'AbortError'))
                },
                { once: true }
              )
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
    )
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RemoteLanguageModel protocol and lifecycle', () => {
  it('times out after the first chunk and releases cancellation listeners', async () => {
    vi.useFakeTimers()
    stallAfterFirstChunk()
    const controller = new AbortController()
    const stream = reply(controller.signal, 20)
    expect((await stream.next()).value).toBe('first')
    let outcome: unknown = 'pending'
    const pending = stream.next().then(
      (value) => {
        outcome = value
      },
      (error) => {
        outcome = error
      }
    )
    await vi.advanceTimersByTimeAsync(100)
    try {
      expect(outcome).toMatchObject({ kind: 'TIMEOUT' })
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      controller.abort()
      await pending
    }
  })

  it('keeps cancellation distinct from timeout when waiting for another chunk', async () => {
    stallAfterFirstChunk()
    const controller = new AbortController()
    const stream = reply(controller.signal)
    await stream.next()
    const pending = stream.next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it.each([
    ['JSON instead of SSE', '{"choices":[{"message":{"content":"hello"}}]}', 'application/json'],
    ['invalid chunk shape', event({ unexpected: true }) + DONE, 'text/event-stream'],
    ['truncated stream', chunk('partial'), 'text/event-stream'],
    ['premature sentinel', chunk('partial') + DONE, 'text/event-stream'],
    ['empty response', STOP + DONE, 'text/event-stream'],
    ['malformed JSON', 'data: {broken}\n\n', 'text/event-stream'],
    ['token limit', chunk('partial') + chunk(null, 'length') + DONE, 'text/event-stream']
  ])('rejects %s instead of completing', async (_name, body, contentType) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    respond(body, contentType)
    await expect(collect(reply())).rejects.toMatchObject({ kind: 'PROTOCOL' })
  })

  it('accepts role, content, stop and usage chunks and ignores late content', async () => {
    const controller = new AbortController()
    respond(
      event({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) +
        chunk('Hello') +
        STOP +
        event({ choices: [], usage: { total_tokens: 3 } }) +
        DONE +
        chunk('late')
    )
    expect(await collect(reply(controller.signal))).toEqual(['Hello'])
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it.each(['zh-CN', 'en'])(
    'sends separate explanation and practice languages for %s',
    async (outputLanguage) => {
      respond(chunk('Hello') + STOP + DONE)
      await collect(
        new RemoteLanguageModel(CONFIG).streamReply({
          messages: [{ role: 'user', content: 'Practice with me' }],
          outputLanguage,
          targetLanguage: 'en',
          signal: new AbortController().signal
        })
      )
      const init = vi.mocked(fetch).mock.calls[0][1]
      const body = JSON.parse(init?.body as string) as { messages: { content: string }[] }
      const prompt = body.messages[0].content
      expect(prompt).toContain(
        `Write explanations, feedback and instructions in ${outputLanguage === 'zh-CN' ? 'Simplified Chinese (zh-CN)' : 'English (en)'}.`
      )
      expect(prompt).toContain(
        'Write practice dialogue, example sentences and corrected sentences in English (en).'
      )
      expect(prompt).not.toContain('every part')
    }
  )

  it('does not contact the service for an already cancelled request', async () => {
    respond(STOP + DONE)
    const controller = new AbortController()
    controller.abort()
    await expect(reply(controller.signal).next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
