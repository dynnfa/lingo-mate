import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
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

function memoryStore(initial?: unknown): ModelsConfigStore & { records: unknown[] } {
  const records: unknown[] = initial === undefined ? [] : [initial]
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
  systemPrompt: string
  purpose: 'conversation'
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
  systemPrompt: `Explain in ${outputLanguage === 'zh-CN' ? 'Simplified Chinese (zh-CN)' : 'English (en)'}. Examples in English (en).`,
  purpose: 'conversation',
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
    return new ModelConfigService(store, fakeVault, randomUUID)
  }

  async function collectReply(
    model: ConfiguredLanguageModel,
    signal = new AbortController().signal
  ): Promise<string> {
    let text = ''
    for await (const event of model.streamReply(STREAM_INPUT(signal))) {
      if (event.type === 'text') text += event.delta
    }
    return text
  }

  it('streams a reply through the active config with an explicit output language', async () => {
    const store = memoryStore()
    const service = serviceFor(store)
    service.createConfig({
      protocol: 'openai-compatible',
      baseUrl: `${streamingServer.baseUrl}/v1`,
      modelId: 'fake-model',
      credential: { action: 'keep' }
    })
    const model = new ConfiguredLanguageModel(service, createClient)

    expect(await collectReply(model)).toBe('你好，世界')
    const request = streamingServer.requests.at(-1)
    expect(request?.path).toBe('/v1/chat/completions')
    expect(request?.body.model).toBe('fake-model')
    expect(request?.body.stream).toBe(true)
    // 指令中显式声明输出语言，不依赖消息内容推断
    expect(request?.body.messages[0]).toMatchObject({ role: 'system' })
    expect(request?.body.messages[0]?.content).toContain('Simplified Chinese (zh-CN)')
  })

  it('sends the configured api key and maps auth failures to safe codes', async () => {
    const service = serviceFor(memoryStore())
    service.createConfig({
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

  it('keeps multiple configs across restarts with isolated credentials and a stable active selection', () => {
    const store = memoryStore()
    const first = serviceFor(store)
    const created = first.createConfig({
      protocol: 'openai-compatible',
      baseUrl: `${streamingServer.baseUrl}/v1`,
      modelId: 'model-a',
      credential: { action: 'replace', apiKey: 'sk-a' }
    })
    const configA = created.configs[0]
    const createdB = first.createConfig({
      protocol: 'openai-compatible',
      baseUrl: `${secondServer.baseUrl}/v1`,
      modelId: 'model-b',
      credential: { action: 'keep' }
    })
    const configB = createdB.configs[1]
    first.setActiveConfig(configB.id)

    // 模拟重启：同一存储上的新服务实例
    const restarted = serviceFor(store)
    const list = restarted.getList()
    expect(list.configs.map((config) => [config.id, config.modelId, config.hasApiKey])).toEqual([
      [configA.id, 'model-a', true],
      [configB.id, 'model-b', false]
    ])
    expect(list.activeConfigId).toBe(configB.id)

    // 凭据按记录归属，不串用
    expect(restarted.resolveConfigSnapshot(configA.id)).toMatchObject({ apiKey: 'sk-a' })
    expect(restarted.resolveConfigSnapshot(configB.id)).toMatchObject({ apiKey: undefined })
    expect(restarted.resolveSnapshot()).toMatchObject({ modelId: 'model-b', apiKey: undefined })
  })

  it('row tests resolve their own target without changing the active selection', () => {
    const service = serviceFor(memoryStore())
    const created = service.createConfig({
      protocol: 'openai-compatible',
      baseUrl: `${streamingServer.baseUrl}/v1`,
      modelId: 'model-a',
      credential: { action: 'keep' }
    })
    const createdB = service.createConfig({
      protocol: 'openai-compatible',
      baseUrl: `${secondServer.baseUrl}/v1`,
      modelId: 'model-b',
      credential: { action: 'keep' }
    })

    // 行测试按 ID 解析目标配置；当前选择保持第一条
    const rowSnapshot = service.resolveConfigSnapshot(createdB.configs[1].id)
    expect(rowSnapshot).toMatchObject({ modelId: 'model-b' })
    expect(service.getList().activeConfigId).toBe(created.configs[0].id)
    expect(service.resolveSnapshot()).toMatchObject({ modelId: 'model-a' })
  })

  it('applies edits, switches, and deletions only to new requests, never in-flight streams', async () => {
    const store = memoryStore()
    const service = serviceFor(store)
    const created = service.createConfig({
      protocol: 'openai-compatible',
      baseUrl: `${slowServer.baseUrl}/v1`,
      modelId: 'fake-model',
      credential: { action: 'keep' }
    })
    const model = new ConfiguredLanguageModel(service, createClient)

    const controller = new AbortController()
    const iterator = model.streamReply(STREAM_INPUT(controller.signal, 'en'))
    const firstChunk = iterator.next()

    // 在途流未完成时编辑该记录
    service.updateConfig({
      configId: created.configs[0].id,
      protocol: 'openai-compatible',
      baseUrl: `${secondServer.baseUrl}/v1`,
      modelId: 'edited-model',
      credential: { action: 'keep' }
    })

    releaseStreamStart()
    const streamed = await firstChunk
    expect(streamed.value).toEqual({ type: 'text', delta: 'late' })
    // 排空旧流
    await iterator.next()

    // 下一次请求使用编辑后的配置
    expect(await collectReply(model)).toBe('second-service')
    expect(secondServer.requests.at(-1)?.body.model).toBe('edited-model')

    // 删除当前模型：在途流不受影响，后续请求回到未配置
    const pendingStream = model.streamReply(STREAM_INPUT(new AbortController().signal, 'en')).next()
    service.deleteConfig(created.configs[0].id)
    await pendingStream
    await expect(collectReply(model)).rejects.toBeInstanceOf(ModelNotConfiguredError)
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
