import type { IpcMainInvokeEvent } from 'electron'
import { BrowserWindow, ipcMain } from 'electron'
import type { SupportedLocale } from '../shared/preferences'
import {
  vocabularyPracticeCancelInputSchema,
  vocabularyPracticeCancelResultSchema,
  vocabularyPracticeReviewInputSchema,
  vocabularyPracticeReviewResultSchema,
  vocabularyPracticeStartInputSchema,
  vocabularyPracticeStartResultSchema,
  VOCABULARY_PRACTICE_CHANNELS,
  type VocabularyPracticeError,
  type VocabularyPracticeReviewResult,
  type VocabularyPracticeStartResult,
  type VocabularyPracticeCancelResult
} from '../shared/vocabulary-practice'
import { VocabularyError } from '../core/learning/vocabulary/parse-vocabulary-input'
import { VocabularyPracticeError as CoreVocabularyPracticeError } from '../core/learning/vocabulary-practice/parse-vocabulary-practice-input'
import type { VocabularyPracticeService } from '../core/learning/vocabulary-practice/vocabulary-practice-service'

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留练习协议的
// 安全错误码，不携带数据库路径、SQL、模型地址或异常堆栈。
export function toSafeVocabularyPracticeError(error: unknown): VocabularyPracticeError {
  if (error instanceof CoreVocabularyPracticeError) return { code: error.code }
  if (error instanceof VocabularyError && error.code === 'STORAGE_FAILED') {
    return { code: 'STORAGE_FAILED' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 注册词汇练习 IPC；审查语言按当前界面语言解析，随请求快照传入。
// 返回清理函数用于卸载时移除注册。
export function registerVocabularyPracticeIpc(
  service: VocabularyPracticeService,
  resolveExplanationLanguage: () => SupportedLocale,
  trustedRendererUrl: string
): () => void {
  const startHandler = (
    event: IpcMainInvokeEvent,
    rawInput: unknown
  ): VocabularyPracticeStartResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = vocabularyPracticeStartInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      const outcome = service.start(input.data.count)
      // 出口同样过 schema：结果不符合协议时按安全错误报告。
      return vocabularyPracticeStartResultSchema.parse({
        status: 'ok',
        sessionId: outcome.sessionId,
        requestedCount: outcome.requestedCount,
        actualCount: outcome.entries.length,
        entries: outcome.entries
      })
    } catch (error) {
      return { status: 'error', error: toSafeVocabularyPracticeError(error) }
    }
  }

  const reviewHandler = async (
    event: IpcMainInvokeEvent,
    rawInput: unknown
  ): Promise<VocabularyPracticeReviewResult> => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = vocabularyPracticeReviewInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      const outcome = await service.review(
        input.data.sessionId,
        input.data.answers,
        resolveExplanationLanguage()
      )
      return vocabularyPracticeReviewResultSchema.parse({
        status: 'ok',
        verdict: outcome.verdict,
        summary: outcome.summary,
        marks: outcome.marks
      })
    } catch (error) {
      return { status: 'error', error: toSafeVocabularyPracticeError(error) }
    }
  }

  const cancelHandler = (
    event: IpcMainInvokeEvent,
    rawInput: unknown
  ): VocabularyPracticeCancelResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = vocabularyPracticeCancelInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      return vocabularyPracticeCancelResultSchema.parse({
        status: 'ok',
        cancelled: service.cancel(input.data.sessionId)
      })
    } catch (error) {
      return { status: 'error', error: toSafeVocabularyPracticeError(error) }
    }
  }

  ipcMain.handle(VOCABULARY_PRACTICE_CHANNELS.start, startHandler)
  ipcMain.handle(VOCABULARY_PRACTICE_CHANNELS.review, reviewHandler)
  ipcMain.handle(VOCABULARY_PRACTICE_CHANNELS.cancel, cancelHandler)
  return () => {
    ipcMain.removeHandler(VOCABULARY_PRACTICE_CHANNELS.start)
    ipcMain.removeHandler(VOCABULARY_PRACTICE_CHANNELS.review)
    ipcMain.removeHandler(VOCABULARY_PRACTICE_CHANNELS.cancel)
  }
}

// 只允许本应用窗口当前加载的可信主文档；同源子 frame 也不继承练习权限。
function isTrustedSource(event: IpcMainInvokeEvent, rendererUrl: string): boolean {
  return (
    !event.sender.isDestroyed() &&
    BrowserWindow.fromWebContents(event.sender)?.webContents === event.sender &&
    event.senderFrame != null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === rendererUrl
  )
}
