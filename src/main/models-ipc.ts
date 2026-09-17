import type { WebContents } from 'electron'
import type { RegisterTrustedHandler, TrustedHandlerConfig } from './ipc-guard'
import { noInputSchema } from './ipc-guard'
import type { ModelConnectionTester } from '../core/llm/model-connection-tester'
import {
  ModelConfigNotFoundError,
  ModelConfigValidationError,
  ModelsReadError,
  ModelsWriteError,
  type ModelConfigService
} from '../core/llm/model-config'
import type { ZodIssue } from 'zod'
import {
  cancelModelsTestInputSchema,
  cancelModelsTestResultSchema,
  createModelConfigInputSchema,
  deleteModelConfigInputSchema,
  MODELS_CHANNELS,
  modelsConfigListResultSchema,
  setActiveModelConfigInputSchema,
  testDraftModelsConnectionInputSchema,
  testModelsConnectionResultSchema,
  testSavedModelsConnectionInputSchema,
  updateModelConfigInputSchema,
  type ModelsError,
  type TestModelsConnectionResult
} from '../shared/models'

interface ActiveTest {
  requestId: string
  controller: AbortController
}

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留错误码与字段名，
// 不携带内部原因、密钥或展示文案；文案由 Renderer 翻译。
export function toSafeModelsError(error: unknown): ModelsError {
  if (error instanceof ModelConfigValidationError) {
    return error.field !== undefined
      ? { code: error.code, field: error.field }
      : { code: error.code }
  }
  if (error instanceof ModelConfigNotFoundError) {
    return { code: 'CONFIG_NOT_FOUND' }
  }
  if (error instanceof ModelsReadError) {
    return { code: 'MODELS_READ_FAILED' }
  }
  if (error instanceof ModelsWriteError) {
    return { code: 'MODELS_WRITE_FAILED' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 协议层校验失败映射到字段级错误码，不回传包含密钥的完整校验异常。
function invalidInputError(issues: readonly ZodIssue[]): ModelsError {
  for (const issue of issues) {
    if (issue.path.includes('configId') || issue.path.includes('editTargetConfigId')) {
      return { code: 'INVALID_CONFIG_ID' }
    }
    if (issue.path.includes('baseUrl')) return { code: 'INVALID_BASE_URL', field: 'baseUrl' }
    if (issue.path.includes('modelId')) return { code: 'INVALID_MODEL_ID', field: 'modelId' }
    if (issue.path.includes('apiKey')) return { code: 'INVALID_API_KEY', field: 'apiKey' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 每窗口最多一个连接测试（行测试与草稿测试共享限额）：requestId 关联取消；
// sender 销毁时中止其活动测试。测试目标的编辑、保存和删除禁用由 Renderer
// 保证，Main 侧不重复加锁。来源检查、输入与结果校验由公共守卫执行。
export function registerModelsIpc(
  service: ModelConfigService,
  tester: ModelConnectionTester,
  registerTrustedHandler: RegisterTrustedHandler
): () => void {
  const activeTestsBySender = new Map<number, ActiveTest>()

  // 集合读取沿用旧语义：读取路径上的任何失败都按 MODELS_READ_FAILED 报告。
  const removeList = registerTrustedHandler({
    channel: MODELS_CHANNELS.listConfigs,
    inputSchema: noInputSchema,
    resultSchema: modelsConfigListResultSchema,
    invalidInputError: () => ({ code: 'UNKNOWN_ERROR' }),
    mapError: () => ({ code: 'MODELS_READ_FAILED' }),
    fallbackError: { code: 'MODELS_READ_FAILED' },
    handler: () => ({ status: 'ok', list: service.getList() })
  } satisfies TrustedHandlerConfig<typeof noInputSchema, typeof modelsConfigListResultSchema>)

  const removeCreate = registerTrustedHandler({
    channel: MODELS_CHANNELS.createConfig,
    inputSchema: createModelConfigInputSchema,
    resultSchema: modelsConfigListResultSchema,
    invalidInputError,
    mapError: toSafeModelsError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => {
      service.createConfig(input)
      return { status: 'ok', list: service.getList() }
    }
  } satisfies TrustedHandlerConfig<
    typeof createModelConfigInputSchema,
    typeof modelsConfigListResultSchema
  >)

  const removeUpdate = registerTrustedHandler({
    channel: MODELS_CHANNELS.updateConfig,
    inputSchema: updateModelConfigInputSchema,
    resultSchema: modelsConfigListResultSchema,
    invalidInputError,
    mapError: toSafeModelsError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => {
      service.updateConfig(input)
      return { status: 'ok', list: service.getList() }
    }
  } satisfies TrustedHandlerConfig<
    typeof updateModelConfigInputSchema,
    typeof modelsConfigListResultSchema
  >)

  const removeDelete = registerTrustedHandler({
    channel: MODELS_CHANNELS.deleteConfig,
    inputSchema: deleteModelConfigInputSchema,
    resultSchema: modelsConfigListResultSchema,
    invalidInputError,
    mapError: toSafeModelsError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => {
      service.deleteConfig(input.configId)
      return { status: 'ok', list: service.getList() }
    }
  } satisfies TrustedHandlerConfig<
    typeof deleteModelConfigInputSchema,
    typeof modelsConfigListResultSchema
  >)

  const removeSetActive = registerTrustedHandler({
    channel: MODELS_CHANNELS.setActiveConfig,
    inputSchema: setActiveModelConfigInputSchema,
    resultSchema: modelsConfigListResultSchema,
    invalidInputError,
    mapError: toSafeModelsError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => {
      service.setActiveConfig(input.configId)
      return { status: 'ok', list: service.getList() }
    }
  } satisfies TrustedHandlerConfig<
    typeof setActiveModelConfigInputSchema,
    typeof modelsConfigListResultSchema
  >)

  // 行测试与草稿测试共用一个执行包装：槽位占用检查、取消关联与清理一致。
  // start 同步抛错时也必须经 finally 释放槽位，避免连接测试名额泄漏。
  const runConnectionTest = async (
    sender: WebContents,
    requestId: string,
    start: (signal: AbortSignal) => Promise<TestModelsConnectionResult>
  ): Promise<TestModelsConnectionResult> => {
    if (activeTestsBySender.has(sender.id)) {
      return { status: 'error', error: { code: 'TEST_IN_PROGRESS' } }
    }

    const activeTest: ActiveTest = {
      requestId,
      controller: new AbortController()
    }
    const onSenderDestroyed = (): void => activeTest.controller.abort()
    activeTestsBySender.set(sender.id, activeTest)
    sender.once('destroyed', onSenderDestroyed)

    try {
      return await start(activeTest.controller.signal)
    } finally {
      if (activeTestsBySender.get(sender.id) === activeTest) {
        activeTestsBySender.delete(sender.id)
        sender.removeListener('destroyed', onSenderDestroyed)
      }
    }
  }

  const removeTestSaved = registerTrustedHandler({
    channel: MODELS_CHANNELS.testSavedConnection,
    inputSchema: testSavedModelsConnectionInputSchema,
    resultSchema: testModelsConnectionResultSchema,
    invalidInputError,
    mapError: toSafeModelsError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input, { sender }) =>
      runConnectionTest(sender, input.requestId, (signal) =>
        tester.test(service.resolveConfigSnapshot(input.configId), signal)
      )
  } satisfies TrustedHandlerConfig<
    typeof testSavedModelsConnectionInputSchema,
    typeof testModelsConnectionResultSchema
  >)

  const removeTestDraft = registerTrustedHandler({
    channel: MODELS_CHANNELS.testDraftConnection,
    inputSchema: testDraftModelsConnectionInputSchema,
    resultSchema: testModelsConnectionResultSchema,
    invalidInputError,
    mapError: toSafeModelsError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input, { sender }) =>
      runConnectionTest(sender, input.requestId, (signal) => {
        const draft = service.resolveDraftConfig(input, input.editTargetConfigId)
        return tester.test(draft.config, signal)
      })
  } satisfies TrustedHandlerConfig<
    typeof testDraftModelsConnectionInputSchema,
    typeof testModelsConnectionResultSchema
  >)

  const removeCancelTest = registerTrustedHandler({
    channel: MODELS_CHANNELS.cancelTest,
    inputSchema: cancelModelsTestInputSchema,
    resultSchema: cancelModelsTestResultSchema,
    invalidInputError: () => ({ code: 'UNKNOWN_ERROR' }),
    mapError: toSafeModelsError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input, { sender }) => {
      const activeTest = activeTestsBySender.get(sender.id)
      // 幂等取消：请求已结束或 requestId 不匹配时同样返回成功。
      if (activeTest && activeTest.requestId === input.requestId) {
        activeTest.controller.abort()
      }
      return { status: 'ok' }
    }
  } satisfies TrustedHandlerConfig<
    typeof cancelModelsTestInputSchema,
    typeof cancelModelsTestResultSchema
  >)

  return () => {
    removeList()
    removeCreate()
    removeUpdate()
    removeDelete()
    removeSetActive()
    removeTestSaved()
    removeTestDraft()
    removeCancelTest()
  }
}
