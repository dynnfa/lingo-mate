import { BrowserWindow, dialog, type WebContents } from 'electron'
import { open, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { VocabularyEntry } from '../shared/vocabulary'
import type { SupportedLocale } from '../shared/preferences'
import { TransferError } from '../core/learning/vocabulary/vocabulary-transfer'
import { VOCABULARY_TRANSFER_LIMITS as LIMITS } from '../shared/vocabulary-transfer'
import { decodeVocabularyExcel, encodeVocabularyExcel } from './vocabulary-excel'
import type { VocabularyTransferFiles } from './vocabulary-transfer-ipc'
import en from '../shared/locales/en/vocabulary.json'
import zh from '../shared/locales/zh-CN/vocabulary.json'

export function createVocabularyTransferFiles(
  exportAll: () => VocabularyEntry[]
): VocabularyTransferFiles {
  const windowFor = (sender: WebContents): Electron.BrowserWindow => {
    const window = BrowserWindow.fromWebContents(sender)
    if (!window || sender.isDestroyed()) throw new TransferError('CANCELLED')
    return window
  }
  const messages = (locale: SupportedLocale): typeof en.transfer | typeof zh.transfer =>
    (locale === 'en' ? en : zh).transfer
  return {
    async preview(sender, locale) {
      const result = await dialog.showOpenDialog(windowFor(sender), {
        title: messages(locale).selectFile,
        filters: [{ name: messages(locale).excelFile, extensions: ['xlsx'] }],
        properties: ['openFile']
      })
      if (result.canceled || sender.isDestroyed()) return null
      const path = result.filePaths[0]
      if (!path || extname(path).toLowerCase() !== '.xlsx') throw new TransferError('INVALID_FILE')
      try {
        const file = await open(path, 'r')
        let bytes: Buffer
        try {
          if ((await file.stat()).size > LIMITS.fileBytes) throw new TransferError('LIMIT_EXCEEDED')
          // Bounded read also covers a file growing after stat.
          bytes = Buffer.alloc(LIMITS.fileBytes + 1)
          let length = 0
          while (length < bytes.length) {
            const read = await file.read(bytes, length, bytes.length - length, length)
            if (!read.bytesRead) break
            length += read.bytesRead
          }
          if (length > LIMITS.fileBytes) throw new TransferError('LIMIT_EXCEEDED')
          bytes = bytes.subarray(0, length)
        } finally {
          await file.close()
        }
        return await decodeVocabularyExcel(bytes)
      } catch (error) {
        if (error instanceof TransferError) throw error
        throw new TransferError('FILE_ERROR', { cause: error })
      }
    },
    async save(sender, locale, template) {
      const result = await dialog.showSaveDialog(windowFor(sender), {
        title: template ? messages(locale).template : messages(locale).export,
        defaultPath: template ? 'vocabulary-template.xlsx' : 'vocabulary.xlsx',
        filters: [{ name: messages(locale).excelFile, extensions: ['xlsx'] }]
      })
      if (result.canceled || !result.filePath || sender.isDestroyed()) return false
      const entries = template ? [] : exportAll()
      try {
        const bytes = await encodeVocabularyExcel(entries, locale)
        if (sender.isDestroyed()) return false
        const path =
          extname(result.filePath).toLowerCase() === '.xlsx'
            ? result.filePath
            : `${result.filePath}.xlsx`
        await writeFile(path, bytes)
        return true
      } catch (error) {
        throw new TransferError('FILE_ERROR', { cause: error })
      }
    }
  }
}
