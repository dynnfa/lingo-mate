import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { BrowserWindow, ipcMain } from 'electron'
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
  createModelConfigInputSchema,
  deleteModelConfigInputSchema,
  MODELS_CHANNELS,
  modelsConfigListSchema,
  setActiveModelConfigInputSchema,
  testDraftModelsConnectionInputSchema,
  testSavedModelsConnectionInputSchema,
  updateModelConfigInputSchema,
  type CancelModelsTestResult,
  type ModelsConfigListResult,
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

// 变更操作共用同一包装：来源校验 → 输入校验 → 服务调用 → 安全列表回传。
function runMutation(
  event: IpcMainInvokeEvent,
  trustedRendererUrl: string,
  rawInput: unknown,
  parse: (input: unknown) => { ok: true; run: () => void } | { ok: false; error: ModelsError },
  service: ModelConfigService
): ModelsConfigListResult {
  if (!isTrustedSource(event, trustedRendererUrl)) return untrustedSource()
  const input = parse(rawInput)
  if (!input.ok) return { status: 'error', error: input.error }
  try {
    input.run()
    return { status: 'ok', list: modelsConfigListSchema.parse(service.getList()) }
  } catch (error) {
    return { status: 'error', error: toSafeModelsError(error) }
  }
}

// 每窗口最多一个连接测试（行测试与草稿测试共享限额）：requestId 关联取消；
// sender 销毁时中止其活动测试。测试目标的编辑、保存和删除禁用由 Renderer
// 保证，Main 侧不重复加锁。
export function registerModelsIpc(
  service: ModelConfigService,
  tester: ModelConnectionTester,
  trustedRendererUrl: string
): void {
  const activeTestsBySender = new Map<number, ActiveTest>()

  ipcMain.handle(MODELS_CHANNELS.listConfigs, (event): ModelsConfigListResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) return untrustedSource()
    try {
      return { status: 'ok', list: modelsConfigListSchema.parse(service.getList()) }
    } catch {
      return { status: 'error', error: { code: 'MODELS_READ_FAILED' } }
    }
  })

  ipcMain.handle(MODELS_CHANNELS.createConfig, (event, rawInput: unknown): ModelsConfigListResult =>
    runMutation(
      event,
      trustedRendererUrl,
      rawInput,
      (input) => {
        const parsed = createModelConfigInputSchema.safeParse(input)
        return parsed.success
          ? { ok: true, run: () => service.createConfig(parsed.data) }
          : { ok: false, error: invalidInputError(parsed.error.issues) }
      },
      service
    )
  )

  ipcMain.handle(MODELS_CHANNELS.updateConfig, (event, rawInput: unknown): ModelsConfigListResult =>
    runMutation(
      event,
      trustedRendererUrl,
      rawInput,
      (input) => {
        const parsed = updateModelConfigInputSchema.safeParse(input)
        return parsed.success
          ? { ok: true, run: () => service.updateConfig(parsed.data) }
          : { ok: false, error: invalidInputError(parsed.error.issues) }
      },
      service
    )
  )

  ipcMain.handle(MODELS_CHANNELS.deleteConfig, (event, rawInput: unknown): ModelsConfigListResult =>
    runMutation(
      event,
      trustedRendererUrl,
      rawInput,
      (input) => {
        const parsed = deleteModelConfigInputSchema.safeParse(input)
        return parsed.success
          ? { ok: true, run: () => service.deleteConfig(parsed.data.configId) }
          : { ok: false, error: invalidInputError(parsed.error.issues) }
      },
      service
    )
  )

  ipcMain.handle(
    MODELS_CHANNELS.setActiveConfig,
    (event, rawInput: unknown): ModelsConfigListResult =>
      runMutation(
        event,
        trustedRendererUrl,
        rawInput,
        (input) => {
          const parsed = setActiveModelConfigInputSchema.safeParse(input)
          return parsed.success
            ? { ok: true, run: () => service.setActiveConfig(parsed.data.configId) }
            : { ok: false, error: invalidInputError(parsed.error.issues) }
        },
        service
      )
  )

  // 行测试与草稿测试共用一个执行包装：槽位占用检查、取消关联与清理一致。
  const runConnectionTest = async (
    event: IpcMainInvokeEvent,
    rawInput: unknown,
    parse: (input: unknown) =>
      | {
          ok: true
          requestId: string
          start: (signal: AbortSignal) => Promise<TestModelsConnectionResult>
        }
      | { ok: false; error: ModelsError }
  ): Promise<TestModelsConnectionResult> => {
    if (!isTrustedSource(event, trustedRendererUrl)) return untrustedSource()
    const input = parse(rawInput)
    if (!input.ok) return { status: 'error', error: input.error }

    const sender: WebContents = event.sender
    if (activeTestsBySender.has(sender.id)) {
      return { status: 'error', error: { code: 'TEST_IN_PROGRESS' } }
    }

    const activeTest: ActiveTest = {
      requestId: input.requestId,
      controller: new AbortController()
    }
    const onSenderDestroyed = (): void => activeTest.controller.abort()
    activeTestsBySender.set(sender.id, activeTest)
    sender.once('destroyed', onSenderDestroyed)

    try {
      return await input.start(activeTest.controller.signal)
    } catch (error) {
      return { status: 'error', error: toSafeModelsError(error) }
    } finally {
      if (activeTestsBySender.get(sender.id) === activeTest) {
        activeTestsBySender.delete(sender.id)
        sender.removeListener('destroyed', onSenderDestroyed)
      }
    }
  }

  ipcMain.handle(MODELS_CHANNELS.testSavedConnection, (event, rawInput: unknown) =>
    runConnectionTest(event, rawInput, (input) => {
      const parsed = testSavedModelsConnectionInputSchema.safeParse(input)
      return parsed.success
        ? {
            ok: true,
            requestId: parsed.data.requestId,
            start: (signal) =>
              tester.test(service.resolveConfigSnapshot(parsed.data.configId), signal)
          }
        : { ok: false, error: invalidInputError(parsed.error.issues) }
    })
  )

  ipcMain.handle(MODELS_CHANNELS.testDraftConnection, (event, rawInput: unknown) =>
    runConnectionTest(event, rawInput, (input) => {
      const parsed = testDraftModelsConnectionInputSchema.safeParse(input)
      return parsed.success
        ? {
            ok: true,
            requestId: parsed.data.requestId,
            start: (signal) => {
              const draft = service.resolveDraftConfig(parsed.data, parsed.data.editTargetConfigId)
              return tester.test(draft.config, signal)
            }
          }
        : { ok: false, error: invalidInputError(parsed.error.issues) }
    })
  )

  ipcMain.handle(MODELS_CHANNELS.cancelTest, (event, rawInput: unknown): CancelModelsTestResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) return untrustedSource()
    const input = cancelModelsTestInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    }
    const activeTest = activeTestsBySender.get(event.sender.id)
    // 幂等取消：请求已结束或 requestId 不匹配时同样返回成功。
    if (activeTest && activeTest.requestId === input.data.requestId) {
      activeTest.controller.abort()
    }
    return { status: 'ok' }
  })
}

// 只允许本应用窗口当前加载的可信主文档；同源子 frame 也不继承模型配置权限。
function isTrustedSource(event: IpcMainInvokeEvent, rendererUrl: string): boolean {
  return (
    !event.sender.isDestroyed() &&
    BrowserWindow.fromWebContents(event.sender)?.webContents === event.sender &&
    event.senderFrame != null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === rendererUrl
  )
}

function untrustedSource(): { status: 'error'; error: ModelsError } {
  return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
}
