import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmClient, type LlmStreamChunk } from '../llm-client'
import { LlmUsageRecorder } from '../llm-usage-recorder'
import type { LlmUsageTerminal } from '../llm-usage'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

const params = {
  model: 'gemini-test',
  messages: [{ role: 'user' as const, content: 'Reply in English: hello' }]
}
const context = { operation: 'conversation' as const, timeoutMs: 1000 }
const reply = (
  parts: unknown[] = [{ text: 'hello' }],
  finishReason = 'STOP'
): Record<string, unknown> => ({
  candidates: [{ content: { parts }, finishReason }],
  modelVersion: 'gemini-test',
  usageMetadata: {
    promptTokenCount: 5,
    candidatesTokenCount: 32,
    thoughtsTokenCount: 135,
    totalTokenCount: 172
  }
})
function client(): { client: LlmClient; finished: LlmUsageTerminal[] } {
  const finished: LlmUsageTerminal[] = []
  return {
    finished,
    client: new LlmClient(
      { protocol: 'gemini', baseUrl: 'https://example.com/gemini/v1beta/', apiKey: 'test-key' },
      new LlmUsageRecorder({
        insertStarted: () => {},
        finish: (record) => {
          finished.push(record)
        },
        markInterruptedStarted: () => 0,
        list: () => []
      })
    )
  }
}
afterEach(() => vi.unstubAllGlobals())

describe('Gemini transport through LlmClient', () => {
  it('uses native URL, authentication, system instruction and counts thinking tokens', async () => {
    const fetchMock = vi.fn(async () => Response.json(reply()))
    vi.stubGlobal('fetch', fetchMock)
    const subject = client()
    const result = await subject.client.complete(
      {
        ...params,
        messages: [{ role: 'system', content: 'Respond in English.' }, ...params.messages]
      },
      context
    )
    expect(result.choices[0].message.content).toBe('hello')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.com/gemini/v1beta/models/gemini-test:generateContent')
    expect(init.headers).toMatchObject({ 'x-api-key': 'test-key', 'x-goog-api-key': 'test-key' })
    expect(init.redirect).toBe('error')
    expect(JSON.parse(String(init.body))).toMatchObject({
      systemInstruction: { parts: [{ text: 'Respond in English.' }] },
      contents: [{ role: 'user', parts: [{ text: params.messages[0].content }] }]
    })
    expect(subject.finished[0]).toMatchObject({
      status: 'completed',
      inputTokens: 5,
      outputTokens: 167,
      totalTokens: 172
    })
  })

  it('replays original signed parts and tool results across rounds', async () => {
    const parts = [
      { thought: true, text: 'private', thoughtSignature: 'opaque' },
      {
        functionCall: { name: 'lookup', args: { word: 'hello' }, id: 'provider-call' },
        thoughtSignature: 'signed-call'
      }
    ]
    const fetchMock = vi.fn(async () => Response.json(reply(parts)))
    vi.stubGlobal('fetch', fetchMock)
    const subject = client()
    const first = await subject.client.complete(params, context)
    expect(first.choices[0].message.content).toBeNull()
    const call = first.choices[0].message.tool_calls![0]
    const messages: ChatCompletionMessageParam[] = [
      ...params.messages,
      first.choices[0].message,
      { role: 'tool', tool_call_id: call.id, content: '{"found":true}' }
    ]
    await subject.client.complete(
      {
        ...params,
        messages,
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              parameters: { type: 'object', properties: { word: { type: 'string' } } }
            }
          }
        ],
        tool_choice: 'required'
      },
      context
    )
    const init = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(String(init.body))).toMatchObject({
      contents: [
        { role: 'user' },
        { role: 'model', parts },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'lookup', id: 'provider-call', response: { found: true } } }
          ]
        }
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } }
    })
  })

  it('decodes SSE split across bytes and preserves final usage', async () => {
    const body = `: comment\r\ndata: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '你好' }] } }] })}\r\n\r\ndata: ${JSON.stringify(reply([]))}\r\n\r\n`
    const bytes = new TextEncoder().encode(body)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
                controller.close()
              }
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
      )
    )
    const subject = client()
    const chunks: LlmStreamChunk[] = []
    for await (const chunk of subject.client.stream(params, context)) chunks.push(chunk)
    expect(chunks[0].choices[0].delta.content).toBe('你好')
    expect(chunks[1].choices[0].finish_reason).toBe('stop')
    expect(subject.finished[0].status).toBe('completed')
    expect(subject.finished[0].totalTokens).toBe(172)
  })

  it('maps thought summary parts to reasoning_content and requests them when streaming', async () => {
    const body =
      `data: ${JSON.stringify({
        candidates: [
          { content: { parts: [{ text: '先想一下', thought: true, thoughtSignature: 'sig' }] } }
        ]
      })}\n\n` +
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'hello' }] } }]
      })}\n\n` +
      `data: ${JSON.stringify(reply([]))}\n\n`
    const fetchMock = vi.fn(
      async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    )
    vi.stubGlobal('fetch', fetchMock)
    const subject = client()
    const chunks: LlmStreamChunk[] = []
    for await (const chunk of subject.client.stream(params, context)) chunks.push(chunk)

    // 流式请求显式开启思考摘要；签名与正文分片不混入思考。
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const request = JSON.parse(String(requestInit.body)) as {
      generationConfig: { includeThoughts?: boolean }
    }
    expect(request.generationConfig.includeThoughts).toBe(true)
    expect(chunks[0].choices[0].delta).toMatchObject({ reasoning_content: '先想一下' })
    expect(chunks[1].choices[0].delta).toMatchObject({ content: 'hello' })
    expect((chunks[0].choices[0].delta as { content?: unknown }).content).toBe(null)
    expect(chunks[2].choices[0].finish_reason).toBe('stop')
  })

  it('does not request thought summaries for non-streaming calls', async () => {
    const fetchMock = vi.fn(async () => Response.json(reply()))
    vi.stubGlobal('fetch', fetchMock)
    await client().client.complete(params, context)
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const request = JSON.parse(String(requestInit.body)) as {
      generationConfig: { includeThoughts?: boolean }
    }
    expect(request.generationConfig.includeThoughts).toBeUndefined()
  })

  it.each([401, 403, 404])('classifies HTTP %i errors', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status }))
    )
    await expect(client().client.complete(params, context)).rejects.toMatchObject({
      kind: status === 404 ? 'MODEL_UNAVAILABLE' : 'AUTH'
    })
  })

  it.each([
    'data: {}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n',
    'data: {'
  ])('fails malformed or unfinished streams', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    )
    const subject = client()
    await expect(
      (async () => {
        for await (const chunk of subject.client.stream(params, context)) void chunk
      })()
    ).rejects.toMatchObject({ kind: 'PROTOCOL' })
    expect(subject.finished[0].status).toBe('failed')
  })

  it('retains timeout and cancellation semantics even if fetch ignores abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    )
    const subject = client()
    await expect(
      subject.client.complete(params, { ...context, timeoutMs: 5 })
    ).rejects.toMatchObject({ kind: 'TIMEOUT' })
    const controller = new AbortController()
    const pending = subject.client.complete(params, { ...context, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(subject.finished.map((record) => record.status)).toEqual(['failed', 'cancelled'])
  })
})
