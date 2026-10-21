import { resolve } from 'node:path'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/database/database'
import { SqliteLlmUsageRepository } from '../../src/database/sqlite-llm-usage-repository'
import { ConfiguredLanguageModel } from '../../src/core/llm/configured-language-model'
import { ModelConnectionTester } from '../../src/core/llm/model-connection-tester'
import { randomUUID } from 'node:crypto'
import {
  ModelConfigService,
  ModelNotConfiguredError,
  type ModelsConfigStore
} from '../../src/core/llm/model-config'
import { LlmClient, type CreateLlmClient } from '../../src/core/llm/llm-client'
import { LlmUsageRecorder } from '../../src/core/llm/llm-usage-recorder'

// 可控提供方：流式请求按场景输出 正文 → stop → 终止后正文分片 →（延迟）尾部
// usage 分片；非流式请求返回 JSON completion。usage.model 不随响应 model 伪装。
interface Scenario {
  content: string[]
  tailDelayMs: number
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  responseModel: string
}

function startProviderServer(getScenario: () => Scenario): Promise<{
  baseUrl: string
  close(): Promise<void>
}> {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string
        stream?: boolean
      }
      const setup = getScenario()

      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (value: unknown): void => {
          res.write(`data: ${JSON.stringify({ model: setup.responseModel, ...value })}\n\n`)
        }
        send({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
        for (const text of setup.content) {
          send({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
        }
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        // 终止标记后的正文分片：不得污染回复，但流必须继续消费到尾部用量。
        send({ choices: [{ index: 0, delta: { content: 'POLLUTED' }, finish_reason: null }] })
        await new Promise((resolve) => setTimeout(resolve, setup.tailDelayMs))
        if (setup.usage) send({ choices: [], usage: setup.usage })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fixture',
          object: 'chat.completion',
          model: setup.responseModel,
          ...(setup.usage ? { usage: setup.usage } : {}),
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: setup.content.join('') || 'ok' },
              finish_reason: 'stop'
            }
          ]
        })
      )
    })()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}

function memoryStore(): ModelsConfigStore {
  let record: unknown
  return {
    read: () => record,
    write: (value: unknown | null) => {
      record = value
    }
  }
}

const fakeVault = {
  isAvailable: () => true,
  encrypt: (plainText: string) => `enc:${plainText}`,
  decrypt: (serialized: string) => serialized.replace(/^enc:/, '')
}

describe('LLM usage ledger across the unified client', () => {
  let scenario: Scenario
  let server: Awaited<ReturnType<typeof startProviderServer>>
  let database: ReturnType<typeof openDatabase>
  let usageRepository: SqliteLlmUsageRepository
  let createClient: CreateLlmClient

  beforeAll(async () => {
    server = await startProviderServer(() => scenario)
    database = openDatabase(':memory:')
    usageRepository = new SqliteLlmUsageRepository(database)
    const recorder = new LlmUsageRecorder(usageRepository)
    createClient = (config) => new LlmClient(config, recorder)
  })

  afterAll(async () => {
    database.close()
    await server.close()
  })

  function configuredModel(modelId: string, store = memoryStore()): ConfiguredLanguageModel {
    const service = new ModelConfigService(store, fakeVault, randomUUID)
    service.createConfig({
      protocol: 'openai-compatible',
      baseUrl: server.baseUrl,
      modelId,
      credential: { action: 'keep' }
    })
    return new ConfiguredLanguageModel(service, createClient)
  }

  async function streamReply(model: ConfiguredLanguageModel): Promise<string> {
    let text = ''
    for await (const event of model.streamReply({
      messages: [{ role: 'user', content: 'Practice English with me.' }],
      systemPrompt: 'Explain in Simplified Chinese (zh-CN). Examples in English (en).',
      purpose: 'conversation',
      signal: new AbortController().signal
    })) {
      if (event.type === 'text') text += event.delta
    }
    return text
  }

  it('records exactly one model attempt per Python conversation or concept task', async () => {
    scenario = {
      content: ['graph reply'],
      tailDelayMs: 0,
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      responseModel: 'fixture'
    }
    const configured = configuredModel('python-pilot-usage')
    const runtime = new PythonAgentRuntime(
      new PythonAgentProcess({
        command: resolve(
          'agent-engine/.venv',
          process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
        ),
        args: ['-I', '-m', 'lingo_agent']
      }),
      () => configured.snapshot()
    )
    try {
      for (const task of ['conversation', 'word-concept'] as const) {
        let text = ''
        for await (const event of runtime.stream({
          sessionId: task,
          task: 'conversation',
          messages: [{ role: 'user', content: task === 'conversation' ? 'Hi' : '/concept carry' }],
          outputLanguage: 'zh-CN',
          targetLanguage: 'en',
          signal: new AbortController().signal
        })) {
          if (event.type === 'text') text += event.delta
        }
        expect(text).toBe('graph reply')
      }
      const rows = usageRepository.list({ modelId: 'python-pilot-usage' })
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.status === 'completed' && row.totalTokens === 12)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps a resolved host model across configuration changes for multiple calls', async () => {
    scenario = { content: ['stable'], tailDelayMs: 0, responseModel: 'fixture' }
    const store = memoryStore()
    const configured = configuredModel('frozen-host-model', store)
    const frozen = configured.snapshot()
    const service = new ModelConfigService(store, fakeVault, randomUUID)
    service.deleteConfig(service.getList().activeConfigId!)
    for (let call = 0; call < 2; call++) {
      for await (const event of frozen.streamReply({
        messages: [{ role: 'user', content: 'Hi' }],
        systemPrompt: 'Explain in Simplified Chinese (zh-CN). Examples in English (en).',
        purpose: 'conversation',
        signal: new AbortController().signal
      }))
        void event
    }
    expect(usageRepository.list({ modelId: 'frozen-host-model' })).toHaveLength(2)
    expect(() => configured.snapshot()).toThrow(ModelNotConfiguredError)
  })

  it('records a conversation stream with tail usage and an unpolluted reply', async () => {
    scenario = {
      content: ['你好', '，', '世界'],
      tailDelayMs: 10,
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      responseModel: 'provider-alias-model'
    }
    expect(await streamReply(configuredModel('request-model'))).toBe('你好，世界')

    const rows = usageRepository.list({ modelId: 'request-model' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      operation: 'conversation',
      status: 'completed',
      modelId: 'request-model',
      responseModelId: 'provider-alias-model',
      inputTokens: 42,
      outputTokens: 7,
      totalTokens: 49,
      usageStatus: 'reported',
      errorCode: null,
      finishedAt: expect.any(Number)
    })
  })

  it('keeps the recorded request snapshot after settings change', async () => {
    scenario = {
      content: ['Hi'],
      tailDelayMs: 0,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      responseModel: 'provider-alias-model'
    }
    const store = memoryStore()
    expect(await streamReply(configuredModel('snapshot-model', store))).toBe('Hi')

    // 已落库记录的 model 是调用时快照，切换设置不回写历史。
    const service = new ModelConfigService(store, fakeVault, randomUUID)
    const switched = service.createConfig({
      protocol: 'openai-compatible',
      baseUrl: server.baseUrl,
      modelId: 'switched-model',
      credential: { action: 'keep' }
    })
    service.setActiveConfig(switched.configs[1].id)
    const snapshotRow = usageRepository.list({ modelId: 'snapshot-model' })
    expect(snapshotRow).toHaveLength(1)
    expect(snapshotRow[0]).toMatchObject({ status: 'completed', inputTokens: 1 })

    // 新请求按新配置记账，各自一行。
    expect(await streamReply(new ConfiguredLanguageModel(service, createClient))).toBe('Hi')
    expect(usageRepository.list({ modelId: 'switched-model' })).toHaveLength(1)
    expect(usageRepository.list({ modelId: 'snapshot-model' })).toHaveLength(1)
  })

  it('records a connection test against the unsaved draft model', async () => {
    scenario = {
      content: [],
      tailDelayMs: 0,
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      responseModel: 'provider-alias-model'
    }
    const service = new ModelConfigService(memoryStore(), fakeVault, randomUUID)
    service.createConfig({
      protocol: 'openai-compatible',
      baseUrl: server.baseUrl,
      modelId: 'saved-model',
      credential: { action: 'keep' }
    })
    const tester = new ModelConnectionTester(2_000, createClient)
    // 测试使用未保存草稿：记录草稿 model，而不是已保存设置。
    const draft = service.resolveDraftConfig({
      protocol: 'openai-compatible',
      baseUrl: server.baseUrl,
      modelId: 'draft-model',
      credential: { action: 'keep' }
    })
    expect(await tester.test(draft.config, new AbortController().signal)).toEqual({ status: 'ok' })
    const rows = usageRepository.list({ modelId: 'draft-model' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      operation: 'connection_test',
      status: 'completed',
      inputTokens: 3,
      outputTokens: 1,
      totalTokens: 4,
      usageStatus: 'reported'
    })
    expect(usageRepository.list({ modelId: 'saved-model' })).toHaveLength(0)
  })

  it('adds a new row per retry and never records unconfigured requests', async () => {
    scenario = {
      content: ['Hello'],
      tailDelayMs: 0,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      responseModel: 'provider-alias-model'
    }
    const model = configuredModel('retry-model')
    await streamReply(model)
    await streamReply(model) // 用户重试产生新调用，不覆盖原记录
    expect(usageRepository.list({ modelId: 'retry-model' })).toHaveLength(2)

    // 未配置模型：抛出明确错误，不产生真实请求记录。
    const before = usageRepository.list({}).length
    const unconfigured = new ConfiguredLanguageModel(
      new ModelConfigService(memoryStore(), fakeVault, randomUUID),
      createClient
    )
    await expect(streamReply(unconfigured)).rejects.toMatchObject({
      name: 'ModelNotConfiguredError'
    })
    expect(usageRepository.list({})).toHaveLength(before)
  })
})
