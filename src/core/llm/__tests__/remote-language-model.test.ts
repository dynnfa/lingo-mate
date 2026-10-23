import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteLanguageModel } from '../remote-language-model'
import type { ModelStreamEvent } from '../language-model'
import { LlmClient, type CreateLlmClient } from '../llm-client'
import { LlmUsageRecorder } from '../llm-usage-recorder'

const CONFIG = {
  configured: true as const,
  protocol: 'openai-compatible' as const,
  baseUrl: 'https://model.invalid/v1',
  modelId: 'test-model',
  apiKey: undefined
}
// 适配器测试不关心账本内容；用量记账由 llm-client 与集成测试覆盖。
const createClient: CreateLlmClient = (config) =>
  new LlmClient(
    config,
    new LlmUsageRecorder({
      insertStarted: () => {},
      finish: () => {},
      markInterruptedStarted: () => 0,
      list: () => []
    })
  )
const encoder = new TextEncoder()
const event = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const chunk = (content: string | null, finishReason: string | null = null): string =>
  event({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })
// DeepSeek 系提供方在 delta.reasoning_content 上返回思考增量。
const reasoningChunk = (reasoning: string | null): string =>
  event({ choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] })
const STOP = chunk(null, 'stop')
const DONE = 'data: [DONE]\n\n'

function reply(
  signal = new AbortController().signal,
  timeoutMs = 1_000
): AsyncGenerator<ModelStreamEvent> {
  return new RemoteLanguageModel(CONFIG, timeoutMs, createClient).streamReply({
    messages: [{ role: 'user', content: 'Help me practice English.' }],
    systemPrompt: 'Explain in Simplified Chinese (zh-CN). Examples in English (en).',
    purpose: 'conversation',
    signal
  })
}

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const chunks: ModelStreamEvent[] = []
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
    expect((await stream.next()).value).toEqual({ type: 'text', delta: 'first' })
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
    ['token limit', chunk('partial') + chunk(null, 'length') + DONE, 'text/event-stream']
  ])('rejects %s instead of completing', async (_name, body, contentType) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    respond(body, contentType)
    await expect(collect(reply())).rejects.toMatchObject({ kind: 'PROTOCOL' })
  })

  it('propagates SSE decoding failures without wrapping', async () => {
    // 传输/解码错误由客户端分类记账后原样抛出，业务层不做二次包装。
    respond('data: {broken}\n\n')
    await expect(collect(reply())).rejects.toThrow(SyntaxError)
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
    expect(await collect(reply(controller.signal))).toEqual([{ type: 'text', delta: 'Hello' }])
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('forwards explicit system instructions without selecting a Prompt from command text', async () => {
    respond(chunk('Hello') + STOP + DONE)
    const systemPrompt = 'Custom instructions. Explain in English.'
    await collect(
      new RemoteLanguageModel(CONFIG, 1_000, createClient).streamReply({
        messages: [{ role: 'user', content: '/concept pursue' }],
        systemPrompt,
        purpose: 'conversation',
        signal: new AbortController().signal
      })
    )
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
    expect(body.messages).toEqual([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '/concept pursue' }
    ])
  })

  it.each(['zh-CN', 'en'])(
    'requests only a title in the configured language %s',
    async (outputLanguage) => {
      respond(chunk('Coffee practice') + STOP + DONE)
      await collect(
        new RemoteLanguageModel(CONFIG, 1_000, createClient).streamReply({
          messages: [{ role: 'user', content: '/concept coffee' }],
          systemPrompt: `Return only the title. Write the title in ${outputLanguage === 'en' ? 'English (en)' : 'Simplified Chinese (zh-CN)'}.`,
          purpose: 'conversation-title',
          signal: new AbortController().signal
        })
      )
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
      expect(body.messages[0].content).toContain(
        `Write the title in ${outputLanguage === 'en' ? 'English (en)' : 'Simplified Chinese (zh-CN)'}`
      )
      expect(body.messages[0].content).toContain('Return only the title')
      expect(body.messages[1]).toEqual({ role: 'user', content: '/concept coffee' })
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

describe('RemoteLanguageModel reasoning separation', () => {
  it('yields reasoning deltas as reasoning events before the text', async () => {
    respond(
      reasoningChunk('Let me think. ') +
        reasoningChunk('The user practices English.') +
        chunk('Hello!') +
        STOP +
        DONE
    )
    expect(await collect(reply())).toEqual([
      { type: 'reasoning', delta: 'Let me think. ' },
      { type: 'reasoning', delta: 'The user practices English.' },
      { type: 'text', delta: 'Hello!' }
    ])
  })

  it('emits reasoning before text when one chunk carries both', async () => {
    respond(
      event({
        choices: [
          { index: 0, delta: { content: 'Hi', reasoning_content: 'think' }, finish_reason: null }
        ]
      }) +
        STOP +
        DONE
    )
    expect(await collect(reply())).toEqual([
      { type: 'reasoning', delta: 'think' },
      { type: 'text', delta: 'Hi' }
    ])
  })

  it('keeps plain text streams working and ignores empty reasoning strings', async () => {
    respond(reasoningChunk('') + reasoningChunk(null) + chunk('Hello') + STOP + DONE)
    expect(await collect(reply())).toEqual([{ type: 'text', delta: 'Hello' }])
  })

  it('rejects a stream that never produces final text even with reasoning', async () => {
    // 仅有思考而无有效正文不能视为成功。
    respond(reasoningChunk('only thoughts here') + STOP + DONE)
    await expect(collect(reply())).rejects.toMatchObject({ kind: 'PROTOCOL' })
  })

  it('ignores reasoning that arrives after stop alongside late content', async () => {
    respond(chunk('Hello') + STOP + reasoningChunk('late thoughts') + chunk('late') + DONE)
    expect(await collect(reply())).toEqual([{ type: 'text', delta: 'Hello' }])
  })
})
