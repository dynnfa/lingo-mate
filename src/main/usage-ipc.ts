import type { IpcMainInvokeEvent } from 'electron'
import { BrowserWindow, ipcMain } from 'electron'
import {
  LlmUsageStatisticsError,
  type LlmUsageStatisticsService
} from '../core/llm/llm-usage-statistics'
import {
  USAGE_CHANNELS,
  usageOverviewInputSchema,
  usageOverviewSchema,
  type UsageError,
  type UsageOverviewResult
} from '../shared/usage'

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留错误码，
// 不携带内部原因；文案由 Renderer 翻译。
export function toSafeUsageError(error: unknown): UsageError {
  if (error instanceof LlmUsageStatisticsError) {
    return { code: error.code === 'OVERFLOW' ? 'USAGE_OVERFLOW' : 'USAGE_READ_FAILED' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 注册用量统计读取 handler；返回清理函数用于卸载时移除注册。
export function registerUsageIpc(
  service: LlmUsageStatisticsService,
  trustedRendererUrl: string
): () => void {
  const handler = (event: IpcMainInvokeEvent, rawInput: unknown): UsageOverviewResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = usageOverviewInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      // 出口同样过 schema：聚合结果不符合协议时按安全错误报告，不外泄内部结构。
      return { status: 'ok', overview: usageOverviewSchema.parse(service.getOverview()) }
    } catch (error) {
      return { status: 'error', error: toSafeUsageError(error) }
    }
  }

  ipcMain.handle(USAGE_CHANNELS.getOverview, handler)
  return () => ipcMain.removeHandler(USAGE_CHANNELS.getOverview)
}

// 只允许本应用窗口当前加载的可信主文档；同源子 frame 也不继承用量读取权限。
function isTrustedSource(event: IpcMainInvokeEvent, rendererUrl: string): boolean {
  return (
    !event.sender.isDestroyed() &&
    BrowserWindow.fromWebContents(event.sender)?.webContents === event.sender &&
    event.senderFrame != null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === rendererUrl
  )
}
