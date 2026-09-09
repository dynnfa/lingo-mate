import type { IpcMainInvokeEvent } from 'electron'
import { BrowserWindow, ipcMain } from 'electron'
import { PhraseError } from '../core/learning/phrase/parse-phrase-input'
import type { PhraseManagementService } from '../core/learning/phrase/phrase-management'
import {
  deletePhraseInputSchema,
  listPhraseInputSchema,
  listPhraseResultSchema,
  deletePhraseResultSchema,
  PHRASE_CHANNELS,
  type DeletePhraseResult,
  type ListPhraseResult,
  type PhraseManagementError
} from '../shared/phrase'

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留管理入口的
// 安全错误码，不携带数据库路径、SQL 或异常堆栈。
export function toSafePhraseManagementError(error: unknown): PhraseManagementError {
  if (error instanceof PhraseError && error.code === 'STORAGE_FAILED') {
    return { code: 'STORAGE_FAILED' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 注册已记录页短语列表与删除 handler；返回清理函数用于卸载时移除注册。
export function registerPhraseIpc(
  service: PhraseManagementService,
  trustedRendererUrl: string
): () => void {
  const listHandler = (event: IpcMainInvokeEvent, rawInput: unknown): ListPhraseResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = listPhraseInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      // 出口同样过 schema：分页结果不符合协议时按安全错误报告，不外泄内部结构。
      const page = service.list(input.data)
      return listPhraseResultSchema.parse({
        status: 'ok',
        entries: page.entries,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      })
    } catch (error) {
      return { status: 'error', error: toSafePhraseManagementError(error) }
    }
  }

  const deleteHandler = (event: IpcMainInvokeEvent, rawInput: unknown): DeletePhraseResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = deletePhraseInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      const outcome = service.deleteByPhrase(input.data)
      return deletePhraseResultSchema.parse({ status: 'ok', ...outcome })
    } catch (error) {
      return { status: 'error', error: toSafePhraseManagementError(error) }
    }
  }

  ipcMain.handle(PHRASE_CHANNELS.list, listHandler)
  ipcMain.handle(PHRASE_CHANNELS.delete, deleteHandler)
  return () => {
    ipcMain.removeHandler(PHRASE_CHANNELS.list)
    ipcMain.removeHandler(PHRASE_CHANNELS.delete)
  }
}

// 只允许本应用窗口当前加载的可信主文档；同源子 frame 也不继承短语管理权限。
function isTrustedSource(event: IpcMainInvokeEvent, rendererUrl: string): boolean {
  return (
    !event.sender.isDestroyed() &&
    BrowserWindow.fromWebContents(event.sender)?.webContents === event.sender &&
    event.senderFrame != null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === rendererUrl
  )
}
