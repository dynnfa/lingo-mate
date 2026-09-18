import type { WebContents } from 'electron'
import type { SupportedLocale } from '../shared/preferences'
import { VocabularyError } from '../core/learning/vocabulary/parse-vocabulary-input'
import {
  TransferError,
  type ImportDataRow,
  type VocabularyTransferService
} from '../core/learning/vocabulary/vocabulary-transfer'
import { noInputSchema, type RegisterTrustedHandler } from './ipc-guard'
import {
  VOCABULARY_TRANSFER_CHANNELS as C,
  fileResultSchema,
  previewResultSchema,
  taskResultSchema,
  confirmImportSchema,
  startImportSchema,
  taskInputSchema,
  cancelImportSchema,
  importTaskSchema,
  type TransferErrorCode
} from '../shared/vocabulary-transfer'

export interface VocabularyTransferFiles {
  preview(sender: WebContents, locale: SupportedLocale): Promise<ImportDataRow[] | null>
  save(sender: WebContents, locale: SupportedLocale, template: boolean): Promise<boolean>
}
export function registerVocabularyTransferIpc(
  service: VocabularyTransferService,
  files: VocabularyTransferFiles,
  language: () => SupportedLocale,
  register: RegisterTrustedHandler
): () => void {
  const owners = new Map<number, { sender: WebContents; cleanup: () => void }>()
  const fileBusy = new Set<number>()
  const own = (sender: WebContents): void => {
    if (owners.has(sender.id)) return
    const cleanup = (): void => {
      service.release(sender.id)
      fileBusy.delete(sender.id)
      owners.delete(sender.id)
    }
    owners.set(sender.id, { sender, cleanup })
    sender.once('destroyed', cleanup)
  }
  const common = {
    invalidInputError: () => ({ code: 'INVALID_INPUT' as const }),
    fallbackError: { code: 'UNKNOWN_ERROR' as const },
    mapError: (error: unknown): { code: TransferErrorCode } => ({
      code:
        error instanceof TransferError || error instanceof VocabularyError
          ? error.code
          : 'UNKNOWN_ERROR'
    })
  }
  const removers = [
    ...(
      [
        ['template', true],
        ['export', false]
      ] as const
    ).map(([name, template]) =>
      register({
        ...common,
        channel: C[name],
        inputSchema: noInputSchema,
        resultSchema: fileResultSchema,
        handler: async (_, { sender }) => {
          own(sender)
          if (fileBusy.has(sender.id)) throw new TransferError('BUSY')
          fileBusy.add(sender.id)
          try {
            return {
              status: (await files.save(sender, language(), template))
                ? ('ok' as const)
                : ('cancelled' as const)
            }
          } finally {
            fileBusy.delete(sender.id)
          }
        }
      })
    ),
    register({
      ...common,
      channel: C.preview,
      inputSchema: noInputSchema,
      resultSchema: previewResultSchema,
      handler: async (_, { sender }) => {
        own(sender)
        service.assertIdle(sender.id)
        if (fileBusy.has(sender.id)) throw new TransferError('BUSY')
        fileBusy.add(sender.id)
        try {
          const rows = await files.preview(sender, language())
          if (!rows || sender.isDestroyed()) return { status: 'cancelled' as const }
          return { status: 'ok' as const, preview: service.preview(sender.id, rows) }
        } finally {
          fileBusy.delete(sender.id)
        }
      }
    }),
    register({
      ...common,
      channel: C.confirm,
      inputSchema: confirmImportSchema,
      resultSchema: taskResultSchema,
      handler: (input, { sender }) => {
        own(sender)
        return { status: 'ok' as const, task: service.confirm(sender.id, input.importId) }
      }
    }),
    register({
      ...common,
      channel: C.start,
      inputSchema: startImportSchema,
      resultSchema: taskResultSchema,
      handler: (input, { sender }) => {
        own(sender)
        if (fileBusy.has(sender.id)) throw new TransferError('BUSY')
        const frame = sender.mainFrame
        const url = frame.url
        return {
          status: 'ok' as const,
          task: service.start(sender.id, input, language(), (task) => {
            if (!sender.isDestroyed() && sender.mainFrame === frame && frame.url === url)
              sender.send(C.event, importTaskSchema.parse(task))
          })
        }
      }
    }),
    register({
      ...common,
      channel: C.task,
      inputSchema: taskInputSchema,
      resultSchema: taskResultSchema,
      handler: (input, { sender }) => ({
        status: 'ok' as const,
        task: service.getTask(sender.id, input.requestId)
      })
    }),
    register({
      ...common,
      channel: C.cancel,
      inputSchema: cancelImportSchema,
      resultSchema: taskResultSchema,
      handler: (input, { sender }) => ({
        status: 'ok' as const,
        task: service.cancel(sender.id, input.requestId)
      })
    })
  ]
  const expiry = setInterval(() => service.expire(), 60_000)
  expiry.unref()
  return () => {
    clearInterval(expiry)
    removers.forEach((remove) => remove())
    for (const { sender, cleanup } of owners.values()) {
      sender.removeListener('destroyed', cleanup)
      cleanup()
    }
  }
}
