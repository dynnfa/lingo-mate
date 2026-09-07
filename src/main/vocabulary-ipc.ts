import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { SupportedLocale } from '../shared/preferences'
import {
  VOCABULARY_CHANNELS,
  addVocabularyBatchInputSchema,
  addVocabularyBatchResultSchema,
  cancelVocabularyBatchInputSchema,
  listVocabularyInputSchema,
  listVocabularyResultSchema,
  type AddVocabularyBatchResult,
  type CancelVocabularyBatchResult,
  type ListVocabularyResult,
  type VocabularyErrorCode
} from '../shared/vocabulary'
import type { VocabularyModule } from '../core/learning/vocabulary/vocabulary-module'
import type { VocabularyRepository } from '../core/learning/vocabulary/vocabulary-repository'
import { VocabularyError } from '../core/learning/vocabulary/parse-vocabulary-input'

export function registerVocabularyIpc(
  module: VocabularyModule,
  repository: VocabularyRepository,
  resolveLanguage: () => SupportedLocale,
  rendererUrl: string
): () => void {
  const active = new Map<number, { requestId: string; detach: () => void }>()
  // Only remember the latest completed ID per window, so a queued cancel after a
  // synchronous commit reports too_late. No persistent task queue or unbounded history.
  const latest = new Map<number, string>()
  const watched = new Map<number, () => void>()
  let disposed = false
  const trusted = (event: IpcMainInvokeEvent): boolean =>
    !disposed &&
    !event.sender.isDestroyed() &&
    BrowserWindow.fromWebContents(event.sender)?.webContents === event.sender &&
    event.senderFrame != null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === rendererUrl
  const error = (
    code: VocabularyErrorCode
  ): { status: 'error'; error: { code: VocabularyErrorCode } } => ({
    status: 'error',
    error: { code }
  })
  const safeError = (cause: unknown): ReturnType<typeof error> =>
    error(cause instanceof VocabularyError ? cause.code : 'UNKNOWN_ERROR')

  ipcMain.handle(
    VOCABULARY_CHANNELS.addBatch,
    async (event, raw: unknown): Promise<AddVocabularyBatchResult> => {
      if (!trusted(event)) return error('UNTRUSTED_SOURCE')
      try {
        const input = addVocabularyBatchInputSchema.safeParse(raw)
        if (!input.success) return error('INVALID_INPUT')
        const sender = event.sender
        if (
          active.has(sender.id) ||
          [...active.values()].some((item) => item.requestId === input.data.requestId)
        )
          return error('BUSY')
        if (!watched.has(sender.id)) {
          const clear = (): void => {
            latest.delete(sender.id)
            watched.delete(sender.id)
          }
          sender.once('destroyed', clear)
          watched.set(sender.id, () => sender.removeListener('destroyed', clear))
        }
        const cancel = (): void => {
          module.cancel(input.data.requestId)
        }
        sender.once('destroyed', cancel)
        active.set(sender.id, {
          requestId: input.data.requestId,
          detach: () => sender.removeListener('destroyed', cancel)
        })
        try {
          const batch = await module.addBatch(input.data, resolveLanguage())
          return addVocabularyBatchResultSchema.parse({ status: 'ok', batch })
        } finally {
          active.get(sender.id)?.detach()
          active.delete(sender.id)
          if (!sender.isDestroyed() && !disposed) latest.set(sender.id, input.data.requestId)
        }
      } catch (cause) {
        return safeError(cause)
      }
    }
  )
  ipcMain.handle(
    VOCABULARY_CHANNELS.cancelBatch,
    (event, raw: unknown): CancelVocabularyBatchResult => {
      if (!trusted(event)) return error('UNTRUSTED_SOURCE')
      const input = cancelVocabularyBatchInputSchema.safeParse(raw)
      if (!input.success) return error('INVALID_INPUT')
      if (active.get(event.sender.id)?.requestId === input.data.requestId)
        return { status: 'ok', outcome: module.cancel(input.data.requestId) }
      if (latest.get(event.sender.id) === input.data.requestId)
        return { status: 'ok', outcome: 'too_late' }
      return error('REQUEST_NOT_FOUND')
    }
  )
  ipcMain.handle(VOCABULARY_CHANNELS.list, (event, raw: unknown): ListVocabularyResult => {
    if (!trusted(event)) return error('UNTRUSTED_SOURCE')
    try {
      const input = listVocabularyInputSchema.safeParse(raw)
      if (!input.success) return error('INVALID_INPUT')
      return listVocabularyResultSchema.parse({ status: 'ok', ...repository.list(input.data) })
    } catch (cause) {
      return safeError(cause)
    }
  })
  return () => {
    disposed = true
    module.dispose()
    for (const item of active.values()) item.detach()
    for (const detach of watched.values()) detach()
    active.clear()
    latest.clear()
    watched.clear()
    for (const channel of Object.values(VOCABULARY_CHANNELS)) ipcMain.removeHandler(channel)
  }
}
