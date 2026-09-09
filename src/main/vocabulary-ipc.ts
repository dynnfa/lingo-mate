import type { IpcMainInvokeEvent } from 'electron'
import { BrowserWindow, ipcMain } from 'electron'
import { VocabularyError } from '../core/learning/vocabulary/parse-vocabulary-input'
import type { VocabularyManagementService } from '../core/learning/vocabulary/vocabulary-management'
import {
  deleteVocabularyInputSchema,
  listVocabularyInputSchema,
  listVocabularyResultSchema,
  deleteVocabularyResultSchema,
  VOCABULARY_CHANNELS,
  type DeleteVocabularyResult,
  type ListVocabularyResult,
  type VocabularyManagementError
} from '../shared/vocabulary'

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留管理入口的
// 安全错误码，不携带数据库路径、SQL 或异常堆栈。
export function toSafeVocabularyManagementError(error: unknown): VocabularyManagementError {
  if (error instanceof VocabularyError && error.code === 'STORAGE_FAILED') {
    return { code: 'STORAGE_FAILED' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 注册已记录页词汇列表与删除 handler；返回清理函数用于卸载时移除注册。
export function registerVocabularyIpc(
  service: VocabularyManagementService,
  trustedRendererUrl: string
): () => void {
  const listHandler = (event: IpcMainInvokeEvent, rawInput: unknown): ListVocabularyResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = listVocabularyInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      // 出口同样过 schema：分页结果不符合协议时按安全错误报告，不外泄内部结构。
      const page = service.list(input.data)
      return listVocabularyResultSchema.parse({
        status: 'ok',
        entries: page.entries,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      })
    } catch (error) {
      return { status: 'error', error: toSafeVocabularyManagementError(error) }
    }
  }

  const deleteHandler = (event: IpcMainInvokeEvent, rawInput: unknown): DeleteVocabularyResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = deleteVocabularyInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      const outcome = service.deleteById(input.data)
      return deleteVocabularyResultSchema.parse({ status: 'ok', ...outcome })
    } catch (error) {
      return { status: 'error', error: toSafeVocabularyManagementError(error) }
    }
  }

  ipcMain.handle(VOCABULARY_CHANNELS.list, listHandler)
  ipcMain.handle(VOCABULARY_CHANNELS.delete, deleteHandler)
  return () => {
    ipcMain.removeHandler(VOCABULARY_CHANNELS.list)
    ipcMain.removeHandler(VOCABULARY_CHANNELS.delete)
  }
}

// 只允许本应用窗口当前加载的可信主文档；同源子 frame 也不继承词汇管理权限。
function isTrustedSource(event: IpcMainInvokeEvent, rendererUrl: string): boolean {
  return (
    !event.sender.isDestroyed() &&
    BrowserWindow.fromWebContents(event.sender)?.webContents === event.sender &&
    event.senderFrame != null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === rendererUrl
  )
}
