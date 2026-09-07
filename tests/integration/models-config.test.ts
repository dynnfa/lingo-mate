import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfiguredLanguageModel } from '../../src/core/llm/configured-language-model'
import { ModelConnectionTester } from '../../src/core/llm/model-connection-tester'
import {
  ModelConfigService,
  ModelNotConfiguredError,
  type CredentialVault,
  type ModelsConfigStore
} from '../../src/core/llm/model-config'
import { RemoteLanguageModel } from '../../src/core/llm/remote-language-model'
import { LlmClient, type CreateLlmClient } from '../../src/core/llm/llm-client'
import { LlmUsageRecorder } from '../../src/core/llm/llm-usage-recorder'

interface RecordedRequest {
  path: string
  authorization: string | undefined
  body: {
    model: string
    stream: boolean
    messages: Array<{ role: string; content: string }>
  }
}

type RequestHandler = (request: RecordedRequest, response: ServerResponse) => void | Promise<void>

// 可控的 OpenAI 兼容假服务：记录请求并按场景响应（SSE 流 / JSON / 错误码）。
function startFakeModelServer(handler: RequestHandler): Promise<{
  baseUrl: string
  requests: RecordedRequest[]
  close(): Promise<void>
}> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer((req, res) => {
    void handle(server, req, res, requests, handler)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}

async function handle(
  _server: Server,
  req: IncomingMessage,
  res: ServerResponse,
  requests: RecordedRequest[],
  handler: RequestHandler
): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RecordedRequest['body']
  const request: RecordedRequest = {
    path: req.url ?? '/',
    authorization: req.headers.authorization,
    body
  }
  requests.push(request)
  await handler(request, res)
}

function writeSseError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message, type: 'invalid_request_error', code: null } }))
}

function writeStream(
  res: ServerResponse,
  deltas: string[],
  options: { delayMs: number; beforeStart?: Promise<void> }
): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  return (async () => {
    await options.beforeStart
    for (const delta of deltas) {
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
        })}\n\n`
      )
      await new Promise((resolve) => setTimeout(resolve, options.delayMs))
    }
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })()
}

function writeCompletion(res: ServerResponse, content: string): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
    })
  )
}

function memoryStore(): ModelsConfigStore & { records: unknown[] } {
  const records: unknown[] = []
  return {
    records,
    read: () => (records.length > 0 ? records[records.length - 1] : undefined),
    write: (record: unknown | null) => {
      records.push(record ?? null)
    }
  }
}

const fakeVault: CredentialVault = {
  isAvailable: () => true,
  encrypt: (plainText) => `enc:${plainText}`,
  decrypt: (serialized) => serialized.replace(/^enc:/, '')
}

interface TestStreamInput {
  messages: Array<{ role: 'user'; content: string }>
  outputLanguage: string
  targetLanguage: string
  signal: AbortSignal
}

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

const STREAM_INPUT = (signal: AbortSignal, outputLanguage = 'zh-CN'): TestStreamInput => ({
  messages: [{ role: 'user', content: 'Hello' }],
  outputLanguage,
  targetLanguage: 'en',
  signal
})

describe('models integration with a fake OpenAI-compatible service', () => {
  let streamingServer: Awaited<ReturnType<typeof startFakeModelServer>>
  let secondServer: Awaited<ReturnType<typeof startFakeModelServer>>
  let completionServer: Awaited<ReturnType<typeof startFakeModelServer>>
  let errorServer: Awaited<ReturnType<typeof startFakeModelServer>>
  let slowServer: Awaited<ReturnType<typeof startFakeModelServer>>

  let releaseStreamStart!: () => void
  let streamStarted!: Promise<void>

  beforeAll(async () => {
    streamingServer = await startFakeModelServer((_request, res) =>
      writeStream(res, ['你好', '，', '世界'], { delayMs: 5 })
    )
    secondServer = await startFakeModelServer((_request, res) =>
      writeStream(res, ['second', '-service'], { delayMs: 5 })
    )
    completionServer = await startFakeModelServer((request, res) => {
      if (request.body.stream) {
        void writeStream(res, ['ok'], { delayMs: 1 })
        return
      }
      writeCompletion(res, 'ok')
    })
    errorServer = await startFakeModelServer((request, res) => {
      if (request.path.includes('auth')) {
        writeSseError(res, 401, 'invalid api key')
        return
      }
      writeSseError(res, 404, `model ${request.body.model} not found`)
    })
    streamStarted = new Promise<void>((resolve) => {
      releaseStreamStart = resolve
    })
    slowServer = await startFakeModelServer((_request, res) =>
      writeStream(res, ['late'], { delayMs: 1, beforeStart: streamStarted })
    )
  })

  afterAll(async () => {
    releaseStreamStart()
    await Promise.all([
      streamingServer.close(),
      secondServer.close(),
      completionServer.close(),
      errorServer.close(),
      slowServer.close()
    ])
  })

  function serviceFor(store: ModelsConfigStore): ModelConfigService {
    return new ModelConfigService(store, fakeVault)
  }

  it('streams a reply through the saved config with an explicit output language', async () => {
    const store = memoryStore()
    const service = serviceFor(store)
    service.save({
      protocol: 'openai-compatible',
      baseUrl: `${streamingServer.baseUrl}/v1`,
      modelId: 'fake-model',
      credential: { action: 'keep' }
    })
    const model = new ConfiguredLanguageModel(service, createClient)

    const chunks: string[] = []
    for await (const delta of model.streamReply(STREAM_INPUT(new AbortController().signal))) {
      chunks.push(delta)
    }

    expect(chunks.join('')).toBe('你好，世界')
    const request = streamingServer.requests.at(-1)
    expect(request?.path).toBe('/v1/chat/completions')
    expect(request?.body.model).toBe('fake-model')
    expect(request?.body.stream).toBe(true)
    // 指令中显式声明输出语言，不依赖消息内容推断
    expect(request?.body.messages[0]).toMatchObject({ role: 'system' })
    expect(request?.body.messages[0]?.content).toContain('Simplified Chinese (zh-CN)')
  })

  it('sends the configured api key and maps auth failures to safe codes', async () => {
    const store = memoryStore()
    const service = serviceFor(store)
    service.save({
      protocol: 'openai-compatible',
      baseUrl: `${errorServer.baseUrl}/auth`,
      modelId: 'fake-model',
      credential: { action: 'replace', apiKey: 'sk-secret' }
    })

    // 密钥只出现在 Authorization 头中
    const snapshot = service.resolveSnapshot()
    if (!snapshot.configured) throw new Error('snapshot should be configured')
    expect(snapshot.apiKey).toBe('sk-secret')

    const tester = new ModelConnectionTester(2_000, createClient)
    const result = await tester.test(snapshot, new AbortController().signal)
    expect(result).toEqual({ status: 'error', error: { code: 'TEST_AUTH_FAILED' } })

    const authedRequest = errorServer.requests.find((request) => request.path.includes('auth'))
    expect(authedRequest?.authorization).toBe('Bearer sk-secret')
  })

  it('classifies model-unavailable responses from the connection tester', async () => {
    const tester = new ModelConnectionTester(2_000, createClient)
    const result = await tester.test(
      {
        configured: true,
        protocol: 'openai-compatible',
        baseUrl: `${errorServer.baseUrl}/v1`,
        modelId: 'missing-model',
        apiKey: undefined
      },
      new AbortController().signal
    )
    expect(result).toEqual({ status: 'error', error: { code: 'TEST_MODEL_UNAVAILABLE' } })
  })

  it('reports timeouts and cancellations distinctly', async () => {
    const tester = new ModelConnectionTester(150, createClient)

    // 超时：服务永不响应（流挂起）
    const timeoutResult = await tester.test(
      {
        configured: true,
        protocol: 'openai-compatible',
        baseUrl: `${slowServer.baseUrl}/v1`,
        modelId: 'fake-model',
        apiKey: undefined
      },
      new AbortController().signal
    )
    expect(timeoutResult).toEqual({ status: 'error', error: { code: 'TEST_TIMEOUT' } })

    // 取消：外部信号先于截止时间触发
    const controller = new AbortController()
    const pending = tester.test(
      {
        configured: true,
        protocol: 'openai-compatible',
        baseUrl: `${slowServer.baseUrl}/v1`,
        modelId: 'fake-model',
        apiKey: undefined
      },
      controller.signal
    )
    controller.abort()
    expect(await pending).toEqual({ status: 'error', error: { code: 'TEST_CANCELLED' } })
  })

  it('succeeds when the minimal request returns usable content', async () => {
    const tester = new ModelConnectionTester(2_000, createClient)
    const result = await tester.test(
      {
        configured: true,
        protocol: 'openai-compatible',
        baseUrl: `${completionServer.baseUrl}/v1`,
        modelId: 'fake-model',
        apiKey: undefined
      },
      new AbortController().signal
    )
    expect(result).toEqual({ status: 'ok' })
    // 非流式最小请求：SDK 不携带 stream 字段
    const request = completionServer.requests.at(-1)
    expect(request?.body.stream).not.toBe(true)
  })

  it('keeps an in-flight stream on its snapshot and applies saves from the next request', async () => {
    const store = memoryStore()
    const service = serviceFor(store)
    service.save({
      protocol: 'openai-compatible',
      baseUrl: `${slowServer.baseUrl}/v1`,
      modelId: 'fake-model',
      credential: { action: 'keep' }
    })
    const model = new ConfiguredLanguageModel(service, createClient)

    const controller = new AbortController()
    const iterator = model.streamReply(STREAM_INPUT(controller.signal, 'en'))
    const firstChunk = iterator.next()

    // 在途流未完成时切换配置到另一台服务
    service.save({
      protocol: 'openai-compatible',
      baseUrl: `${secondServer.baseUrl}/v1`,
      modelId: 'other-model',
      credential: { action: 'keep' }
    })

    releaseStreamStart()
    const streamed = await firstChunk
    expect(streamed.value).toBe('late')
    // 排空旧流
    await iterator.next()

    // 下一次请求使用新配置
    const chunks: string[] = []
    for await (const delta of model.streamReply(STREAM_INPUT(new AbortController().signal, 'en'))) {
      chunks.push(delta)
    }
    expect(chunks.join('')).toBe('second-service')
    expect(secondServer.requests.at(-1)?.body.model).toBe('other-model')
  })

  it('aborts an in-flight stream with AbortError semantics', async () => {
    const model = new RemoteLanguageModel(
      {
        configured: true,
        protocol: 'openai-compatible',
        baseUrl: `${slowServer.baseUrl}/v1`,
        modelId: 'fake-model',
        apiKey: undefined
      },
      120_000,
      createClient
    )

    const controller = new AbortController()
    const pending = model.streamReply(STREAM_INPUT(controller.signal)).next()
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    releaseStreamStart()
  })

  it('fails fast with ModelNotConfiguredError before any network access', async () => {
    const model = new ConfiguredLanguageModel(serviceFor(memoryStore()), createClient)
    await expect(
      model.streamReply(STREAM_INPUT(new AbortController().signal)).next()
    ).rejects.toBeInstanceOf(ModelNotConfiguredError)
  })
})
