import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelConnectionTester } from '../../core/llm/model-connection-tester'
import { LlmClient, type CreateLlmClient } from '../../core/llm/llm-client'
import { LlmUsageRecorder } from '../../core/llm/llm-usage-recorder'
import {
  ModelConfigValidationError,
  ModelsWriteError,
  type ModelConfigService,
  type RuntimeModelConfig
} from '../../core/llm/model-config'
import {
  MODELS_CHANNELS,
  type SaveModelsSettingsInput,
  type TestModelsConnectionInput,
  type TestModelsConnectionResult
} from '../../shared/models'
import { registerModelsIpc } from '../models-ipc'

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  fromWebContents: vi.fn((sender: { owned: boolean }) =>
    sender.owned ? { webContents: sender } : null
  )
}))

vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle },
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents }
}))

const RENDERER_URL = 'file:///app/renderer/index.html'

// IPC 层测试不发起真实请求；客户端工厂只满足装配形状。
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

const REQUEST_ID = '3f70b8ae-7ad9-4eab-aaf4-1cae54aa2477'

class FakeSender extends EventEmitter {
  readonly id = 42
  owned = true
  destroyed = false
  mainFrame = { url: RENDERER_URL }
  readonly send = vi.fn()

  isDestroyed(): boolean {
    return this.destroyed
  }
}

type IpcHandler = (
  event: { sender: FakeSender; senderFrame?: { url: string } | null },
  input: unknown
) => unknown

function registeredHandler(channel: string): IpcHandler {
  const registration = electronMocks.handle.mock.calls.find(([candidate]) => candidate === channel)
  if (!registration) throw new Error(`Missing IPC handler: ${channel}`)
  const handler = registration[1] as IpcHandler
  return (event, input) => handler({ senderFrame: event.sender.mainFrame, ...event }, input)
}

const CONFIGURED_SNAPSHOT: RuntimeModelConfig & { configured: true } = {
  configured: true,
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  modelId: 'gpt-test',
  apiKey: undefined
}

function fakeService(overrides: Partial<ModelConfigService> = {}): ModelConfigService {
  return {
    getSummary: vi.fn(() => ({ configured: false })),
    resolveSnapshot: vi.fn(() => ({ configured: false })),
    save: vi.fn(),
    clear: vi.fn(),
    resolveDraftConfig: vi.fn(() => ({ config: CONFIGURED_SNAPSHOT, credentialRecord: undefined })),
    ...overrides
  } as unknown as ModelConfigService
}

const SAVE_INPUT: SaveModelsSettingsInput = {
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  modelId: 'gpt-test',
  credential: { action: 'keep' }
}

const TEST_INPUT: TestModelsConnectionInput = {
  requestId: REQUEST_ID,
  ...SAVE_INPUT
}

beforeEach(() => {
  electronMocks.handle.mockReset()
})

describe('models IPC', () => {
  it.each(Object.values(MODELS_CHANNELS))(
    'rejects untrusted callers of %s before accessing the service',
    async (channel) => {
      const service = fakeService()
      const tester = { test: vi.fn() } as unknown as ModelConnectionTester
      registerModelsIpc(service, tester, RENDERER_URL)
      const foreign = new FakeSender()
      foreign.owned = false
      const navigated = new FakeSender()
      navigated.mainFrame.url = 'https://untrusted.invalid/'
      const destroyed = new FakeSender()
      destroyed.destroyed = true
      const sender = new FakeSender()
      for (const event of [
        { sender: foreign },
        { sender: navigated },
        { sender: destroyed },
        { sender, senderFrame: { url: RENDERER_URL } },
        { sender, senderFrame: null }
      ]) {
        expect(await registeredHandler(channel)(event, TEST_INPUT)).toEqual({
          status: 'error',
          error: { code: 'UNTRUSTED_SOURCE' }
        })
      }
      expect(service.getSummary).not.toHaveBeenCalled()
      expect(service.save).not.toHaveBeenCalled()
      expect(service.clear).not.toHaveBeenCalled()
      expect(service.resolveDraftConfig).not.toHaveBeenCalled()
      expect(tester.test).not.toHaveBeenCalled()
    }
  )

  it('returns the safe summary for getSettings', () => {
    const service = fakeService({
      getSummary: () => ({
        configured: true,
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'gpt-test',
        hasApiKey: true,
        apiKeyUndecryptable: false
      })
    })
    registerModelsIpc(service, new ModelConnectionTester(1_000, createClient), RENDERER_URL)

    const result = registeredHandler(MODELS_CHANNELS.getSettings)(
      { sender: new FakeSender() },
      undefined
    )
    expect(result).toEqual({
      status: 'ok',
      summary: {
        configured: true,
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'gpt-test',
        hasApiKey: true,
        apiKeyUndecryptable: false
      }
    })
  })

  it('maps read failures to MODELS_READ_FAILED without leaking internals', () => {
    const service = fakeService({
      getSummary: () => {
        throw new Error('EACCES disk')
      }
    })
    registerModelsIpc(service, new ModelConnectionTester(1_000, createClient), RENDERER_URL)

    const result = registeredHandler(MODELS_CHANNELS.getSettings)(
      { sender: new FakeSender() },
      undefined
    )
    expect(result).toEqual({ status: 'error', error: { code: 'MODELS_READ_FAILED' } })
  })

  it('validates save input and maps persistence failures to safe codes', () => {
    const service = fakeService({
      save: () => {
        throw new ModelsWriteError(new Error('io'))
      }
    })
    registerModelsIpc(service, new ModelConnectionTester(1_000, createClient), RENDERER_URL)

    const invalid = registeredHandler(MODELS_CHANNELS.saveSettings)(
      { sender: new FakeSender() },
      { ...SAVE_INPUT, baseUrl: '' }
    )
    expect(invalid).toEqual({
      status: 'error',
      error: { code: 'INVALID_BASE_URL', field: 'baseUrl' }
    })

    const rejected = registeredHandler(MODELS_CHANNELS.saveSettings)(
      { sender: new FakeSender() },
      SAVE_INPUT
    )
    expect(rejected).toEqual({ status: 'error', error: { code: 'MODELS_WRITE_FAILED' } })
  })

  it('rejects saves with unknown error codes when nothing specific applies', () => {
    const service = fakeService({
      save: () => {
        throw new ModelConfigValidationError('INVALID_BASE_URL')
      }
    })
    registerModelsIpc(service, new ModelConnectionTester(1_000, createClient), RENDERER_URL)

    const result = registeredHandler(MODELS_CHANNELS.saveSettings)(
      { sender: new FakeSender() },
      SAVE_INPUT
    )
    expect(result).toEqual({ status: 'error', error: { code: 'INVALID_BASE_URL' } })
  })

  it('clears settings and returns the unconfigured summary', () => {
    const service = fakeService({
      clear: vi.fn(),
      getSummary: () => ({ configured: false })
    })
    registerModelsIpc(service, new ModelConnectionTester(1_000, createClient), RENDERER_URL)

    const result = registeredHandler(MODELS_CHANNELS.clearSettings)(
      { sender: new FakeSender() },
      undefined
    )
    expect(service.clear).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ status: 'ok', summary: { configured: false } })
  })

  it('maps clear failures to MODELS_WRITE_FAILED', () => {
    const failing = fakeService({
      clear: () => {
        throw new ModelsWriteError(new Error('io'))
      }
    })
    registerModelsIpc(failing, new ModelConnectionTester(1_000, createClient), RENDERER_URL)

    expect(
      registeredHandler(MODELS_CHANNELS.clearSettings)({ sender: new FakeSender() }, undefined)
    ).toEqual({ status: 'error', error: { code: 'MODELS_WRITE_FAILED' } })
  })

  it('runs one connection test per sender and resolves through the tester', async () => {
    const service = fakeService()
    const tester = {
      test: vi.fn(
        async (_config: RuntimeModelConfig & { configured: true }, signal: AbortSignal) => {
          if (signal.aborted) {
            return {
              status: 'error',
              error: { code: 'TEST_CANCELLED' }
            } as TestModelsConnectionResult
          }
          return { status: 'ok' } as TestModelsConnectionResult
        }
      )
    } as unknown as ModelConnectionTester
    registerModelsIpc(service, tester, RENDERER_URL)

    const sender = new FakeSender()
    const first = registeredHandler(MODELS_CHANNELS.testConnection)({ sender }, TEST_INPUT)
    const second = registeredHandler(MODELS_CHANNELS.testConnection)({ sender }, TEST_INPUT)

    await expect(first).resolves.toEqual({ status: 'ok' })
    await expect(second).resolves.toEqual({ status: 'error', error: { code: 'TEST_IN_PROGRESS' } })

    // 结束后可以再次测试
    await expect(
      registeredHandler(MODELS_CHANNELS.testConnection)({ sender }, TEST_INPUT)
    ).resolves.toEqual({ status: 'ok' })
  })

  it('resolves draft validation errors from the test path', async () => {
    const service = fakeService({
      resolveDraftConfig: () => {
        throw new ModelConfigValidationError('CROSS_ORIGIN_CREDENTIAL', 'apiKey')
      }
    })
    registerModelsIpc(service, new ModelConnectionTester(1_000, createClient), RENDERER_URL)

    await expect(
      registeredHandler(MODELS_CHANNELS.testConnection)({ sender: new FakeSender() }, TEST_INPUT)
    ).resolves.toEqual({
      status: 'error',
      error: { code: 'CROSS_ORIGIN_CREDENTIAL', field: 'apiKey' }
    })
  })

  it('cancels an in-flight test by requestId and stays idempotent', async () => {
    let releaseTest!: (value: TestModelsConnectionResult) => void
    const pending = new Promise<TestModelsConnectionResult>((resolve) => {
      releaseTest = resolve
    })
    const tester = { test: vi.fn(() => pending) } as unknown as ModelConnectionTester
    registerModelsIpc(fakeService(), tester, RENDERER_URL)

    const sender = new FakeSender()
    const inFlight = registeredHandler(MODELS_CHANNELS.testConnection)(
      { sender },
      TEST_INPUT
    ) as Promise<TestModelsConnectionResult>

    // requestId 不匹配时幂等成功且不打断测试
    expect(
      registeredHandler(MODELS_CHANNELS.cancelTest)(
        { sender },
        { requestId: '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02' }
      )
    ).toEqual({ status: 'ok' })
    expect(tester.test).toHaveBeenCalledTimes(1)

    const testCall = (tester.test as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      unknown,
      AbortSignal
    ]
    const signal = testCall[1]
    expect(signal.aborted).toBe(false)

    expect(
      registeredHandler(MODELS_CHANNELS.cancelTest)({ sender }, { requestId: REQUEST_ID })
    ).toEqual({ status: 'ok' })
    expect(signal.aborted).toBe(true)

    releaseTest({ status: 'error', error: { code: 'TEST_CANCELLED' } })
    await expect(inFlight).resolves.toEqual({ status: 'error', error: { code: 'TEST_CANCELLED' } })
  })

  it('aborts the active test when the sender is destroyed', async () => {
    let releaseTest!: (value: TestModelsConnectionResult) => void
    const pending = new Promise<TestModelsConnectionResult>((resolve) => {
      releaseTest = resolve
    })
    const tester = { test: vi.fn(() => pending) } as unknown as ModelConnectionTester
    registerModelsIpc(fakeService(), tester, RENDERER_URL)

    const sender = new FakeSender()
    const inFlight = registeredHandler(MODELS_CHANNELS.testConnection)(
      { sender },
      TEST_INPUT
    ) as Promise<TestModelsConnectionResult>

    sender.emit('destroyed')

    const testCall = (tester.test as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [
      unknown,
      AbortSignal
    ]
    expect(testCall[1].aborted).toBe(true)

    releaseTest({ status: 'error', error: { code: 'TEST_CANCELLED' } })
    await expect(inFlight).resolves.toEqual({ status: 'error', error: { code: 'TEST_CANCELLED' } })

    // 销毁后 sender 槽位释放，新 sender 可立即测试
    const fresh = new FakeSender()
    await expect(
      registeredHandler(MODELS_CHANNELS.testConnection)({ sender: fresh }, TEST_INPUT)
    ).resolves.toEqual({ status: 'error', error: { code: 'TEST_CANCELLED' } })
  })
})
