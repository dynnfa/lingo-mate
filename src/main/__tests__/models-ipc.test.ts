import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelConnectionTester } from '../../core/llm/model-connection-tester'
import { LlmClient, type CreateLlmClient } from '../../core/llm/llm-client'
import { LlmUsageRecorder } from '../../core/llm/llm-usage-recorder'
import {
  ModelConfigNotFoundError,
  ModelConfigValidationError,
  ModelsWriteError,
  type ModelConfigService,
  type RuntimeModelConfig
} from '../../core/llm/model-config'
import {
  MODELS_CHANNELS,
  type CreateModelConfigInput,
  type ModelsConfigList,
  type TestDraftModelsConnectionInput,
  type TestModelsConnectionResult,
  type TestSavedModelsConnectionInput,
  type UpdateModelConfigInput
} from '../../shared/models'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import { registerModelsIpc } from '../models-ipc'
import { FakeSender, registeredHandler, RENDERER_URL, resetIpcMocks } from './helpers/ipc-test-env'

vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())

const registerTrustedHandler = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })

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
const OTHER_REQUEST_ID = '0d4b2f7e-52c8-4a61-9ac1-30b1e6de9d02'
const CONFIG_ID = 'f9364f0f-f3f4-4ea6-a31d-b55754aa2477'

const CONFIGURED_SNAPSHOT: RuntimeModelConfig & { configured: true } = {
  configured: true,
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  modelId: 'gpt-test',
  apiKey: undefined
}

const SAFE_LIST: ModelsConfigList = {
  activeConfigId: CONFIG_ID,
  configs: [
    {
      id: CONFIG_ID,
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-test',
      hasApiKey: false,
      apiKeyUndecryptable: false,
      apiKeyPreview: null
    }
  ]
}

function fakeService(overrides: Partial<ModelConfigService> = {}): ModelConfigService {
  return {
    getList: vi.fn(() => SAFE_LIST),
    resolveSnapshot: vi.fn(() => ({ configured: false })),
    resolveConfigSnapshot: vi.fn(() => CONFIGURED_SNAPSHOT),
    createConfig: vi.fn(),
    updateConfig: vi.fn(),
    deleteConfig: vi.fn(),
    setActiveConfig: vi.fn(),
    resolveDraftConfig: vi.fn(() => ({ config: CONFIGURED_SNAPSHOT, credentialRecord: undefined })),
    ...overrides
  } as unknown as ModelConfigService
}

const CREATE_INPUT: CreateModelConfigInput = {
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  modelId: 'gpt-test',
  credential: { action: 'keep' }
}

const UPDATE_INPUT: UpdateModelConfigInput = {
  configId: CONFIG_ID,
  ...CREATE_INPUT
}

const SAVED_TEST_INPUT: TestSavedModelsConnectionInput = {
  configId: CONFIG_ID,
  requestId: REQUEST_ID
}

const DRAFT_TEST_INPUT: TestDraftModelsConnectionInput = {
  requestId: REQUEST_ID,
  ...CREATE_INPUT
}

beforeEach(resetIpcMocks)

describe('models IPC', () => {
  it.each(Object.values(MODELS_CHANNELS))(
    'rejects untrusted callers of %s before accessing the service',
    async (channel) => {
      const service = fakeService()
      const tester = { test: vi.fn() } as unknown as ModelConnectionTester
      registerModelsIpc(service, tester, registerTrustedHandler)
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
        expect(await registeredHandler(channel)(event, SAVED_TEST_INPUT)).toEqual({
          status: 'error',
          error: { code: 'UNTRUSTED_SOURCE' }
        })
      }
      expect(service.getList).not.toHaveBeenCalled()
      expect(service.createConfig).not.toHaveBeenCalled()
      expect(service.updateConfig).not.toHaveBeenCalled()
      expect(service.deleteConfig).not.toHaveBeenCalled()
      expect(service.setActiveConfig).not.toHaveBeenCalled()
      expect(service.resolveConfigSnapshot).not.toHaveBeenCalled()
      expect(service.resolveDraftConfig).not.toHaveBeenCalled()
      expect(tester.test).not.toHaveBeenCalled()
    }
  )

  it('returns the safe collection summary for listConfigs', () => {
    registerModelsIpc(
      fakeService(),
      new ModelConnectionTester(1_000, createClient),
      registerTrustedHandler
    )

    const result = registeredHandler(MODELS_CHANNELS.listConfigs)(
      { sender: new FakeSender() },
      undefined
    )
    expect(result).toEqual({ status: 'ok', list: SAFE_LIST })
  })

  it('maps read failures to MODELS_READ_FAILED without leaking internals', () => {
    const service = fakeService({
      getList: () => {
        throw new Error('EACCES disk')
      }
    })
    registerModelsIpc(
      service,
      new ModelConnectionTester(1_000, createClient),
      registerTrustedHandler
    )

    const result = registeredHandler(MODELS_CHANNELS.listConfigs)(
      { sender: new FakeSender() },
      undefined
    )
    expect(result).toEqual({ status: 'error', error: { code: 'MODELS_READ_FAILED' } })
  })

  it('creates a config and returns the refreshed safe list', () => {
    const service = fakeService({
      createConfig: vi.fn(() => SAFE_LIST)
    })
    registerModelsIpc(
      service,
      new ModelConnectionTester(1_000, createClient),
      registerTrustedHandler
    )

    const result = registeredHandler(MODELS_CHANNELS.createConfig)(
      { sender: new FakeSender() },
      CREATE_INPUT
    )
    expect(service.createConfig).toHaveBeenCalledWith(CREATE_INPUT)
    expect(result).toEqual({ status: 'ok', list: SAFE_LIST })
  })

  it.each([
    ['create', MODELS_CHANNELS.createConfig] as const,
    ['update', MODELS_CHANNELS.updateConfig] as const
  ])('validates %s input and maps failures to safe codes', (_name, channel) => {
    const service = fakeService({
      createConfig: () => {
        throw new ModelsWriteError(new Error('io'))
      },
      updateConfig: () => {
        throw new ModelsWriteError(new Error('io'))
      }
    })
    registerModelsIpc(
      service,
      new ModelConnectionTester(1_000, createClient),
      registerTrustedHandler
    )

    const invalid = registeredHandler(channel)(
      { sender: new FakeSender() },
      { ...UPDATE_INPUT, baseUrl: '' }
    )
    expect(invalid).toEqual({
      status: 'error',
      error: { code: 'INVALID_BASE_URL', field: 'baseUrl' }
    })

    const rejected = registeredHandler(channel)({ sender: new FakeSender() }, UPDATE_INPUT)
    expect(rejected).toEqual({ status: 'error', error: { code: 'MODELS_WRITE_FAILED' } })
  })

  it('rejects non-uuid config ids with a stable code before touching the service', async () => {
    const service = fakeService()
    registerModelsIpc(
      service,
      new ModelConnectionTester(1_000, createClient),
      registerTrustedHandler
    )

    expect(
      registeredHandler(MODELS_CHANNELS.updateConfig)(
        { sender: new FakeSender() },
        { ...UPDATE_INPUT, configId: 'model-a' }
      )
    ).toEqual({ status: 'error', error: { code: 'INVALID_CONFIG_ID' } })
    expect(
      registeredHandler(MODELS_CHANNELS.deleteConfig)(
        { sender: new FakeSender() },
        { configId: 'model-a' }
      )
    ).toEqual({ status: 'error', error: { code: 'INVALID_CONFIG_ID' } })
    expect(
      registeredHandler(MODELS_CHANNELS.setActiveConfig)(
        { sender: new FakeSender() },
        { configId: 'model-a' }
      )
    ).toEqual({ status: 'error', error: { code: 'INVALID_CONFIG_ID' } })
    // 输入校验失败在进入异步测试流程前同步返回安全错误。
    expect(
      registeredHandler(MODELS_CHANNELS.testSavedConnection)(
        { sender: new FakeSender() },
        { configId: 'model-a', requestId: REQUEST_ID }
      )
    ).toEqual({ status: 'error', error: { code: 'INVALID_CONFIG_ID' } })
    expect(service.updateConfig).not.toHaveBeenCalled()
  })

  it('maps missing-record errors to CONFIG_NOT_FOUND across id-scoped operations', async () => {
    const service = fakeService({
      updateConfig: () => {
        throw new ModelConfigNotFoundError(CONFIG_ID)
      },
      deleteConfig: () => {
        throw new ModelConfigNotFoundError(CONFIG_ID)
      },
      setActiveConfig: () => {
        throw new ModelConfigNotFoundError(CONFIG_ID)
      },
      resolveConfigSnapshot: () => {
        throw new ModelConfigNotFoundError(CONFIG_ID)
      }
    })
    registerModelsIpc(
      service,
      new ModelConnectionTester(1_000, createClient),
      registerTrustedHandler
    )

    expect(
      registeredHandler(MODELS_CHANNELS.updateConfig)({ sender: new FakeSender() }, UPDATE_INPUT)
    ).toEqual({ status: 'error', error: { code: 'CONFIG_NOT_FOUND' } })
    expect(
      registeredHandler(MODELS_CHANNELS.deleteConfig)(
        { sender: new FakeSender() },
        { configId: CONFIG_ID }
      )
    ).toEqual({ status: 'error', error: { code: 'CONFIG_NOT_FOUND' } })
    expect(
      registeredHandler(MODELS_CHANNELS.setActiveConfig)(
        { sender: new FakeSender() },
        { configId: CONFIG_ID }
      )
    ).toEqual({ status: 'error', error: { code: 'CONFIG_NOT_FOUND' } })
    await expect(
      registeredHandler(MODELS_CHANNELS.testSavedConnection)(
        { sender: new FakeSender() },
        SAVED_TEST_INPUT
      )
    ).resolves.toEqual({ status: 'error', error: { code: 'CONFIG_NOT_FOUND' } })
  })

  it('deletes and selects configs by id and returns the refreshed list', () => {
    const service = fakeService({
      deleteConfig: vi.fn(() => SAFE_LIST),
      setActiveConfig: vi.fn(() => SAFE_LIST)
    })
    registerModelsIpc(
      service,
      new ModelConnectionTester(1_000, createClient),
      registerTrustedHandler
    )

    expect(
      registeredHandler(MODELS_CHANNELS.deleteConfig)(
        { sender: new FakeSender() },
        { configId: CONFIG_ID }
      )
    ).toEqual({ status: 'ok', list: SAFE_LIST })
    expect(service.deleteConfig).toHaveBeenCalledWith(CONFIG_ID)

    expect(
      registeredHandler(MODELS_CHANNELS.setActiveConfig)(
        { sender: new FakeSender() },
        { configId: CONFIG_ID }
      )
    ).toEqual({ status: 'ok', list: SAFE_LIST })
    expect(service.setActiveConfig).toHaveBeenCalledWith(CONFIG_ID)
  })

  it('tests a saved config by id through the shared tester', async () => {
    const service = fakeService()
    const tester = {
      test: vi.fn(async () => ({ status: 'ok' }) as TestModelsConnectionResult)
    } as unknown as ModelConnectionTester
    registerModelsIpc(service, tester, registerTrustedHandler)

    await expect(
      registeredHandler(MODELS_CHANNELS.testSavedConnection)(
        { sender: new FakeSender() },
        SAVED_TEST_INPUT
      )
    ).resolves.toEqual({ status: 'ok' })
    expect(service.resolveConfigSnapshot).toHaveBeenCalledWith(CONFIG_ID)
    expect(tester.test).toHaveBeenCalledWith(CONFIGURED_SNAPSHOT, expect.any(AbortSignal))
  })

  it('shares the single-test quota between saved and draft connection tests', async () => {
    const service = fakeService()
    const tester = {
      test: vi.fn(async () => ({ status: 'ok' }) as TestModelsConnectionResult)
    } as unknown as ModelConnectionTester
    registerModelsIpc(service, tester, registerTrustedHandler)

    const sender = new FakeSender()
    const saved = registeredHandler(MODELS_CHANNELS.testSavedConnection)(
      { sender },
      SAVED_TEST_INPUT
    )
    await expect(
      registeredHandler(MODELS_CHANNELS.testDraftConnection)({ sender }, DRAFT_TEST_INPUT)
    ).resolves.toEqual({ status: 'error', error: { code: 'TEST_IN_PROGRESS' } })
    await expect(saved).resolves.toEqual({ status: 'ok' })

    // 结束后槽位释放，草稿测试可立即进行
    await expect(
      registeredHandler(MODELS_CHANNELS.testDraftConnection)({ sender }, DRAFT_TEST_INPUT)
    ).resolves.toEqual({ status: 'ok' })
  })

  it('resolves a draft test against the declared edit target', async () => {
    const service = fakeService()
    const tester = {
      test: vi.fn(async () => ({ status: 'ok' }) as TestModelsConnectionResult)
    } as unknown as ModelConnectionTester
    registerModelsIpc(service, tester, registerTrustedHandler)

    await registeredHandler(MODELS_CHANNELS.testDraftConnection)(
      { sender: new FakeSender() },
      { ...DRAFT_TEST_INPUT, editTargetConfigId: CONFIG_ID }
    )

    expect(service.resolveDraftConfig).toHaveBeenCalledWith(
      { ...DRAFT_TEST_INPUT, editTargetConfigId: CONFIG_ID },
      CONFIG_ID
    )
    expect(tester.test).toHaveBeenCalledWith(CONFIGURED_SNAPSHOT, expect.any(AbortSignal))
  })

  it('resolves draft validation errors from the test path', async () => {
    const service = fakeService({
      resolveDraftConfig: () => {
        throw new ModelConfigValidationError('CROSS_ORIGIN_CREDENTIAL', 'apiKey')
      }
    })
    registerModelsIpc(
      service,
      new ModelConnectionTester(1_000, createClient),
      registerTrustedHandler
    )

    await expect(
      registeredHandler(MODELS_CHANNELS.testDraftConnection)(
        { sender: new FakeSender() },
        DRAFT_TEST_INPUT
      )
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
    registerModelsIpc(fakeService(), tester, registerTrustedHandler)

    const sender = new FakeSender()
    const inFlight = registeredHandler(MODELS_CHANNELS.testSavedConnection)(
      { sender },
      SAVED_TEST_INPUT
    ) as Promise<TestModelsConnectionResult>

    // requestId 不匹配时幂等成功且不打断测试
    expect(
      registeredHandler(MODELS_CHANNELS.cancelTest)({ sender }, { requestId: OTHER_REQUEST_ID })
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
    registerModelsIpc(fakeService(), tester, registerTrustedHandler)

    const sender = new FakeSender()
    const inFlight = registeredHandler(MODELS_CHANNELS.testSavedConnection)(
      { sender },
      SAVED_TEST_INPUT
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
      registeredHandler(MODELS_CHANNELS.testSavedConnection)({ sender: fresh }, SAVED_TEST_INPUT)
    ).resolves.toEqual({ status: 'error', error: { code: 'TEST_CANCELLED' } })
  })
})
