import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { BrowserWindow, ipcMain } from 'electron'
import type { ModelConnectionTester } from '../core/llm/model-connection-tester'
import {
  ModelConfigValidationError,
  ModelsReadError,
  ModelsWriteError,
  type ModelConfigService
} from '../core/llm/model-config'
import type { ZodIssue } from 'zod'
import {
  cancelModelsTestInputSchema,
  MODELS_CHANNELS,
  modelsSettingsSummarySchema,
  saveModelsSettingsInputSchema,
  testModelsConnectionInputSchema,
  type CancelModelsTestResult,
  type ClearModelsSettingsResult,
  type GetModelsSettingsResult,
  type ModelsError,
  type SaveModelsSettingsResult,
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
    if (issue.path.includes('baseUrl')) return { code: 'INVALID_BASE_URL', field: 'baseUrl' }
    if (issue.path.includes('modelId')) return { code: 'INVALID_MODEL_ID', field: 'modelId' }
    if (issue.path.includes('apiKey')) return { code: 'INVALID_API_KEY', field: 'apiKey' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 每窗口最多一个连接测试：requestId 关联取消；sender 销毁时中止其活动测试。
export function registerModelsIpc(
  service: ModelConfigService,
  tester: ModelConnectionTester,
  trustedRendererUrl: string
): void {
  const activeTestsBySender = new Map<number, ActiveTest>()

  ipcMain.handle(MODELS_CHANNELS.getSettings, (event): GetModelsSettingsResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) return untrustedSource()
    try {
      return { status: 'ok', summary: modelsSettingsSummarySchema.parse(service.getSummary()) }
    } catch {
      return { status: 'error', error: { code: 'MODELS_READ_FAILED' } }
    }
  })

  ipcMain.handle(
    MODELS_CHANNELS.saveSettings,
    (event, rawInput: unknown): SaveModelsSettingsResult => {
      if (!isTrustedSource(event, trustedRendererUrl)) return untrustedSource()
      const input = saveModelsSettingsInputSchema.safeParse(rawInput)
      if (!input.success) {
        return { status: 'error', error: invalidInputError(input.error.issues) }
      }
      try {
        return { status: 'ok', summary: service.save(input.data) }
      } catch (error) {
        return { status: 'error', error: toSafeModelsError(error) }
      }
    }
  )

  ipcMain.handle(MODELS_CHANNELS.clearSettings, (event): ClearModelsSettingsResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) return untrustedSource()
    try {
      service.clear()
      return { status: 'ok', summary: modelsSettingsSummarySchema.parse(service.getSummary()) }
    } catch (error) {
      return { status: 'error', error: toSafeModelsError(error) }
    }
  })

  ipcMain.handle(
    MODELS_CHANNELS.testConnection,
    async (event, rawInput: unknown): Promise<TestModelsConnectionResult> => {
      if (!isTrustedSource(event, trustedRendererUrl)) return untrustedSource()
      const input = testModelsConnectionInputSchema.safeParse(rawInput)
      if (!input.success) {
        return { status: 'error', error: invalidInputError(input.error.issues) }
      }

      const sender: WebContents = event.sender
      if (activeTestsBySender.has(sender.id)) {
        return { status: 'error', error: { code: 'TEST_IN_PROGRESS' } }
      }

      const activeTest: ActiveTest = {
        requestId: input.data.requestId,
        controller: new AbortController()
      }
      const onSenderDestroyed = (): void => activeTest.controller.abort()
      activeTestsBySender.set(sender.id, activeTest)
      sender.once('destroyed', onSenderDestroyed)

      try {
        const draft = service.resolveDraftConfig(input.data)
        return await tester.test(draft.config, activeTest.controller.signal)
      } catch (error) {
        return { status: 'error', error: toSafeModelsError(error) }
      } finally {
        if (activeTestsBySender.get(sender.id) === activeTest) {
          activeTestsBySender.delete(sender.id)
          sender.removeListener('destroyed', onSenderDestroyed)
        }
      }
    }
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
