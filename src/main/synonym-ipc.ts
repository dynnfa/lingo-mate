import type { IpcMainInvokeEvent } from 'electron'
import { BrowserWindow, ipcMain } from 'electron'
import { SynonymError } from '../core/learning/synonym/parse-synonym-input'
import type { SynonymManagementService } from '../core/learning/synonym/synonym-management'
import {
  SYNONYM_CHANNELS,
  synonymListInputSchema,
  synonymListResultSchema,
  type SynonymListResult,
  type SynonymManagementError
} from '../shared/synonym'

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留管理入口的
// 安全错误码，不携带数据库路径、SQL 或异常堆栈。
export function toSafeSynonymManagementError(error: unknown): SynonymManagementError {
  if (error instanceof SynonymError && error.code === 'STORAGE_FAILED') {
    return { code: 'STORAGE_FAILED' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 注册已记录页近义词分组列表 handler；返回清理函数用于卸载时移除注册。
export function registerSynonymIpc(
  service: SynonymManagementService,
  trustedRendererUrl: string
): () => void {
  const listHandler = (event: IpcMainInvokeEvent, rawInput: unknown): SynonymListResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = synonymListInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      // 出口同样过 schema：分页结果不符合协议时按安全错误报告，不外泄内部结构。
      const page = service.list(input.data)
      return synonymListResultSchema.parse({
        status: 'ok',
        groups: page.groups,
        nextCursor: page.nextCursor
      })
    } catch (error) {
      return { status: 'error', error: toSafeSynonymManagementError(error) }
    }
  }

  ipcMain.handle(SYNONYM_CHANNELS.list, listHandler)
  return () => {
    ipcMain.removeHandler(SYNONYM_CHANNELS.list)
  }
}

// 只允许本应用窗口当前加载的可信主文档；同源子 frame 也不继承近义词管理权限。
function isTrustedSource(event: IpcMainInvokeEvent, rendererUrl: string): boolean {
  return (
    !event.sender.isDestroyed() &&
    BrowserWindow.fromWebContents(event.sender)?.webContents === event.sender &&
    event.senderFrame != null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === rendererUrl
  )
}
