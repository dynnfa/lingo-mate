import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmClient } from '../llm-client'
import type { LlmRequestContext } from '../llm-client'
import { LlmUsageRecorder } from '../llm-usage-recorder'
import type { LlmUsageRepository, LlmUsageStart, LlmUsageTerminal } from '../llm-usage'

const CONFIG = { baseUrl: 'https://model.invalid/v1', apiKey: undefined }

const encoder = new TextEncoder()
const event = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
const sseChunk = (content: string | null, finishReason: string | null = null): string =>
  event({
    model: 'provider-model',
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }]
  })
const usageChunk = (usage: unknown): string =>
  event({ model: 'provider-model', choices: [], usage })
const STOP = sseChunk(null, 'stop')
const DONE = 'data: [DONE]\n\n'

function usageRepository(): LlmUsageRepository & {
  started: LlmUsageStart[]
  finished: LlmUsageTerminal[]
} {
  const started: LlmUsageStart[] = []
  const finished: LlmUsageTerminal[] = []
  return {
    started,
    finished,
    insertStarted: (record) => {
      started.push(record)
    },
    finish: (record) => {
      finished.push(record)
    },
    markInterruptedStarted: () => 0,
    list: () => []
  }
}

function makeClient(repo = usageRepository()): {
  client: LlmClient
  repo: ReturnType<typeof usageRepository>
} {
  return { client: new LlmClient(CONFIG, new LlmUsageRecorder(repo)), repo }
}

const CONTEXT = (overrides: Partial<LlmRequestContext> = {}): LlmRequestContext => ({
  operation: 'conversation',
  timeoutMs: 1_000,
  ...overrides
})

const completionBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'provider-model',
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    ...overrides
  })

function respondJson(body: string, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })
    )
  )
}

function respondStream(body: string, contentType = 'text/event-stream'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { headers: { 'content-type': contentType } }))
  )
}

// 传输层无视取消信号：请求永不返回，也不因 abort 提前失败。
function respondHanging(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Promise<Response>(() => {}))
  )
}

function hangingStream(firstChunks: string[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const body of firstChunks) controller.enqueue(encoder.encode(body))
              // 之后既不产出也不关闭：模拟挂起的 SSE。
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
    )
  )
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = []
  for await (const item of stream) items.push(item)
  return items
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('LlmClient.complete', () => {
  it('records exactly one completed row with reported usage and both models', async () => {
    respondJson(completionBody())
    const { client, repo } = makeClient()
    const completion = await client.complete(
      { model: 'request-model', messages: [{ role: 'user', content: 'hi' }] },
      CONTEXT({ operation: 'vocabulary_analysis' })
    )
    expect(completion.choices[0]?.message.content).toBe('ok')

    expect(repo.started).toHaveLength(1)
    expect(repo.started[0]).toMatchObject({
      operation: 'vocabulary_analysis',
      modelId: 'request-model'
    })
    expect(repo.finished).toHaveLength(1)
    expect(repo.finished[0]).toMatchObject({
      id: repo.started[0].id,
      status: 'completed',
      modelId: 'request-model',
      responseModelId: 'provider-model',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      usageStatus: 'reported',
      errorCode: null,
      finishedAt: expect.any(Number)
    })
  })

  it('sends stream: false and never fails the reply on bad usage data', async () => {
    respondJson(completionBody({ usage: { prompt_tokens: 5, completion_tokens: -1 } }))
    const { client, repo } = makeClient()
    const completion = await client.complete(
      { model: 'request-model', messages: [{ role: 'user', content: 'hi' }] },
      CONTEXT()
    )
    expect(completion).toBeDefined()
    expect(repo.finished[0]).toMatchObject({
      status: 'completed',
      inputTokens: 5,
      outputTokens: null,
      totalTokens: null,
      usageStatus: 'invalid'
    })

    const init = vi.mocked(fetch).mock.calls[0][1]
    expect(JSON.parse(String(init?.body))).toMatchObject({ stream: false })
  })

  it('records a JSON decoding failure as a protocol error', async () => {
    respondJson('{broken')
    const { client, repo } = makeClient()
    await expect(client.complete({ model: 'm', messages: [] }, CONTEXT())).rejects.toBeInstanceOf(
      SyntaxError
    )
    expect(repo.finished[0]).toMatchObject({ status: 'failed', errorCode: 'PROTOCOL' })
  })

  it('creates no record and sends nothing for an already cancelled signal', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { client, repo } = makeClient()
    const controller = new AbortController()
    controller.abort()
    await expect(
      client.complete(
        { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        CONTEXT({ signal: controller.signal })
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
    expect(repo.started).toHaveLength(0)
  })

  it('records failed with a TIMEOUT code when the deadline is reached', async () => {
    vi.useFakeTimers()
    respondHanging()
    const { client, repo } = makeClient()
    const pending = client.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      CONTEXT({ timeoutMs: 25 })
    )
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(30)
    await assertion
    expect(repo.finished[0]).toMatchObject({
      status: 'failed',
      errorCode: 'TIMEOUT',
      inputTokens: null,
      usageStatus: 'missing'
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records cancelled when the external signal aborts before any response', async () => {
    respondHanging()
    const { client, repo } = makeClient()
    const controller = new AbortController()
    const pending = client.complete(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      CONTEXT({ signal: controller.signal })
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(repo.finished[0]).toMatchObject({ status: 'cancelled', errorCode: null })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('classifies provider failures into a safe error code and rethrows the cause', async () => {
    respondJson(
      JSON.stringify({ error: { message: 'bad key', type: 'invalid_request_error' } }),
      401
    )
    const { client, repo } = makeClient()
    await expect(
      client.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, CONTEXT())
    ).rejects.toMatchObject({ status: 401 })
    expect(repo.finished[0]).toMatchObject({ status: 'failed', errorCode: 'AUTH' })
  })
})

describe('LlmClient.stream', () => {
  it('consumes the tail after stop and saves the trailing usage-only chunk', async () => {
    respondStream(
      sseChunk('Hello') +
        STOP +
        usageChunk({ prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }) +
        DONE
    )
    const { client, repo } = makeClient()
    const chunks = await collect(client.stream({ model: 'request-model', messages: [] }, CONTEXT()))
    // stop 之后的分片继续交给业务层（不含 usage），由其决定如何处理正文。
    expect(chunks).toHaveLength(3)
    for (const chunk of chunks) {
      expect(chunk).not.toHaveProperty('usage')
    }
    expect(repo.finished[0]).toMatchObject({
      status: 'completed',
      modelId: 'request-model',
      responseModelId: 'provider-model',
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
      usageStatus: 'reported'
    })
  })

  it('requests usage explicitly via stream_options', async () => {
    respondStream(sseChunk('Hello') + STOP + DONE)
    const { client } = makeClient()
    await collect(client.stream({ model: 'm', messages: [] }, CONTEXT()))
    const init = vi.mocked(fetch).mock.calls[0][1]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true }
    })
  })

  it('replaces the usage snapshot instead of accumulating repeated reports', async () => {
    respondStream(
      sseChunk('Hi') +
        usageChunk({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) +
        STOP +
        usageChunk({ prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }) +
        DONE
    )
    const { client, repo } = makeClient()
    await collect(client.stream({ model: 'm', messages: [] }, CONTEXT()))
    expect(repo.finished[0]).toMatchObject({
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
      usageStatus: 'reported'
    })
  })

  it('keeps a partial report instead of dropping it', async () => {
    respondStream(sseChunk('Hello') + STOP + usageChunk({ prompt_tokens: 4 }) + DONE)
    const { client, repo } = makeClient()
    await collect(client.stream({ model: 'm', messages: [] }, CONTEXT()))
    expect(repo.finished[0]).toMatchObject({
      status: 'completed',
      inputTokens: 4,
      outputTokens: null,
      totalTokens: null,
      usageStatus: 'partial'
    })
  })

  it('keeps a completed row with missing usage when the provider never reports', async () => {
    respondStream(sseChunk('Hello') + STOP + DONE)
    const { client, repo } = makeClient()
    await collect(client.stream({ model: 'm', messages: [] }, CONTEXT()))
    expect(repo.finished[0]).toMatchObject({
      status: 'completed',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      usageStatus: 'missing'
    })
  })

  it('records cancelled / CONSUMER_CLOSED with captured usage when the consumer breaks early', async () => {
    hangingStream([
      sseChunk('first'),
      usageChunk({ prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 })
    ])
    const { client, repo } = makeClient()
    const iterator = client.stream({ model: 'm', messages: [] }, CONTEXT())
    expect((await iterator.next()).done).toBe(false)
    expect((await iterator.next()).done).toBe(false)
    await iterator.return?.()
    expect(repo.finished[0]).toMatchObject({
      status: 'cancelled',
      errorCode: 'CONSUMER_CLOSED',
      inputTokens: 9,
      outputTokens: 1,
      totalTokens: 10
    })
  })

  it('records failed / TIMEOUT with the usage captured before the tail stalled', async () => {
    vi.useFakeTimers()
    hangingStream([
      sseChunk('partial'),
      usageChunk({ prompt_tokens: 6, completion_tokens: 6, total_tokens: 12 }),
      STOP
    ])
    const { client, repo } = makeClient()
    const iterator = client.stream({ model: 'm', messages: [] }, CONTEXT({ timeoutMs: 30 }))
    expect((await iterator.next()).done).toBe(false)
    expect((await iterator.next()).done).toBe(false)
    expect((await iterator.next()).done).toBe(false)
    let outcome: unknown = 'pending'
    const pending = iterator.next().then(
      (value) => (outcome = value),
      (error) => (outcome = error)
    )
    await vi.advanceTimersByTimeAsync(50)
    try {
      expect(outcome).not.toBe('pending')
      expect(outcome).toBeInstanceOf(Error)
      expect(repo.finished[0]).toMatchObject({
        status: 'failed',
        errorCode: 'TIMEOUT',
        inputTokens: 6,
        outputTokens: 6,
        totalTokens: 12
      })
    } finally {
      await pending.catch(() => {})
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records cancelled when the external signal aborts mid-stream', async () => {
    hangingStream([sseChunk('first')])
    const { client, repo } = makeClient()
    const controller = new AbortController()
    const iterator = client.stream(
      { model: 'm', messages: [] },
      CONTEXT({ signal: controller.signal })
    )
    expect((await iterator.next()).done).toBe(false)
    const pending = iterator.next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(repo.finished[0]).toMatchObject({ status: 'cancelled', errorCode: null })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('settles cancelled promptly even when the transport ignores the abort signal', async () => {
    hangingStream([sseChunk('first')])
    const { client, repo } = makeClient()
    const controller = new AbortController()
    const iterator = client.stream(
      { model: 'm', messages: [] },
      CONTEXT({ signal: controller.signal, timeoutMs: 10_000 })
    )
    expect((await iterator.next()).done).toBe(false)
    const pending = iterator.next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(repo.finished[0]).toMatchObject({ status: 'cancelled', errorCode: null })
  })

  it.each([
    ['timeout', 'close'],
    ['timeout', 'resume'],
    ['cancel', 'close'],
    ['cancel', 'resume']
  ] as const)(
    'settles %s while paused at yield and preserves the first terminal on %s',
    async (interruption, action) => {
      vi.useFakeTimers()
      hangingStream([usageChunk({ prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 })])
      const { client, repo } = makeClient()
      const controller = new AbortController()
      const iterator = client.stream(
        { model: 'm', messages: [] },
        CONTEXT({ signal: controller.signal, timeoutMs: 30 })
      )
      await iterator.next()
      if (interruption === 'timeout') await vi.advanceTimersByTimeAsync(30)
      else controller.abort()
      try {
        expect(repo.finished).toHaveLength(1)
        expect(repo.finished[0]).toMatchObject({
          status: interruption === 'timeout' ? 'failed' : 'cancelled',
          errorCode: interruption === 'timeout' ? 'TIMEOUT' : null,
          finishedAt: Date.now(),
          inputTokens: 9,
          totalTokens: 10
        })
        const terminal = { ...repo.finished[0] }
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(100)
        if (action === 'close') await iterator.return()
        else
          await expect(iterator.next()).rejects.toMatchObject(
            interruption === 'timeout' ? { kind: 'TIMEOUT' } : { name: 'AbortError' }
          )
        expect(repo.finished).toEqual([terminal])
      } finally {
        await iterator.return()
      }
    }
  )

  it('records failed / PROTOCOL for a non-SSE response', async () => {
    respondStream('{"choices":[]}', 'application/json')
    const { client, repo } = makeClient()
    await expect(
      collect(client.stream({ model: 'm', messages: [] }, CONTEXT()))
    ).rejects.toMatchObject({ kind: 'PROTOCOL' })
    expect(repo.finished[0]).toMatchObject({ status: 'failed', errorCode: 'PROTOCOL' })
  })

  it('creates no record when the signal is aborted before iteration starts', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const { client, repo } = makeClient()
    const controller = new AbortController()
    controller.abort()
    await expect(
      client.stream({ model: 'm', messages: [] }, CONTEXT({ signal: controller.signal })).next()
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
    expect(repo.started).toHaveLength(0)
  })

  it('isolates concurrent requests: each has its own id and terminal row', async () => {
    respondStream(
      sseChunk('a') +
        STOP +
        usageChunk({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) +
        DONE
    )
    const { client, repo } = makeClient()
    const [first, second] = await Promise.all([
      collect(
        client.stream({ model: 'm', messages: [] }, CONTEXT({ operation: 'vocabulary_analysis' }))
      ),
      collect(
        client.stream({ model: 'm', messages: [] }, CONTEXT({ operation: 'vocabulary_analysis' }))
      )
    ])
    // 每个流收到正文、stop 与 usage-only 三个分片。
    expect(first).toHaveLength(3)
    expect(second).toHaveLength(3)
    expect(repo.started).toHaveLength(2)
    expect(repo.finished).toHaveLength(2)
    expect(new Set(repo.finished.map((row) => row.id)).size).toBe(2)
    for (const row of repo.finished) {
      expect(row).toMatchObject({ status: 'completed', inputTokens: 1, totalTokens: 2 })
    }
  })
})

describe('LlmClient deadline vs cancellation semantics', () => {
  it('treats an external deadline abort reason as failed / TIMEOUT, not user cancellation', async () => {
    respondHanging()
    const { client, repo } = makeClient()
    const controller = new AbortController()
    const pending = client.complete(
      { model: 'm', messages: [] },
      CONTEXT({ signal: controller.signal, timeoutMs: 10_000 })
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    // 领域层（如词汇任务期限）以 code: 'TIMEOUT' 中止；客户端不导入其错误类型。
    controller.abort(Object.assign(new Error('deadline'), { code: 'TIMEOUT' }))
    await expect(pending).rejects.toMatchObject({ kind: 'TIMEOUT' })
    expect(repo.finished[0]).toMatchObject({ status: 'failed', errorCode: 'TIMEOUT' })
  })

  it('classifies transport failures as NETWORK for the ledger', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    const { client, repo } = makeClient()
    const error = await client.complete({ model: 'm', messages: [] }, CONTEXT()).then(
      () => undefined,
      (cause: unknown) => cause
    )
    expect(error).toBeInstanceOf(Error)
    expect(repo.finished[0]).toMatchObject({ status: 'failed', errorCode: 'NETWORK' })
  })
})
