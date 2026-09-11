import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { BrowserWindow, ipcMain } from 'electron'
import type { SupportedLocale, TargetLanguage } from '../shared/preferences'
import {
  SENTENCE_PRACTICE_CHANNELS,
  sentencePracticeCancelInputSchema,
  sentencePracticeCancelResultSchema,
  sentencePracticeCloseInputSchema,
  sentencePracticeCloseResultSchema,
  sentencePracticeHintsInputSchema,
  sentencePracticeHintsResultSchema,
  sentencePracticeReviewInputSchema,
  sentencePracticeReviewResultSchema,
  sentencePracticeStartInputSchema,
  sentencePracticeStartResultSchema,
  type SentencePracticeCancelResult,
  type SentencePracticeCloseResult,
  type SentencePracticeError,
  type SentencePracticeHintsResult,
  type SentencePracticeReviewResult,
  type SentencePracticeStartResult
} from '../shared/sentence-practice'
import { VocabularyError } from '../core/learning/vocabulary/parse-vocabulary-input'
import { SentencePracticeError as CoreSentencePracticeError } from '../core/learning/sentence-practice/parse-sentence-practice-input'
import type { SentencePracticeService } from '../core/learning/sentence-practice/sentence-practice-service'

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留练习协议的
// 安全错误码，不携带数据库路径、SQL、模型地址或异常堆栈。
export function toSafeSentencePracticeError(error: unknown): SentencePracticeError {
  if (error instanceof CoreSentencePracticeError) return { code: error.code }
  if (error instanceof VocabularyError && error.code === 'STORAGE_FAILED') {
    return { code: 'STORAGE_FAILED' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 注册造句练习 IPC；解释语言与练习语言按请求快照传入。返回清理函数
// 用于卸载时移除注册。
export function registerSentencePracticeIpc(
  service: SentencePracticeService,
  resolveExplanationLanguage: () => SupportedLocale,
  resolvePracticeLanguage: () => TargetLanguage,
  trustedRendererUrl: string
): () => void {
  let owner: { sender: WebContents; sessionId: string; onDestroyed: () => void } | undefined

  const releaseOwner = (): boolean => {
    if (!owner) return false
    const previous = owner
    owner = undefined
    previous.sender.removeListener('destroyed', previous.onDestroyed)
    return service.close(previous.sessionId)
  }

  const ownsSession = (event: IpcMainInvokeEvent, sessionId: string): boolean =>
    owner?.sender === event.sender && owner.sessionId === sessionId

  const startHandler = (
    event: IpcMainInvokeEvent,
    rawInput: unknown
  ): SentencePracticeStartResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = sentencePracticeStartInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      if (owner && owner.sender !== event.sender) {
        return { status: 'error', error: { code: 'BUSY' } }
      }
      releaseOwner()
      const outcome = service.start()
      const onDestroyed = (): void => {
        releaseOwner()
      }
      owner = { sender: event.sender, sessionId: outcome.sessionId, onDestroyed }
      event.sender.once('destroyed', onDestroyed)
      // 出口同样过 schema：结果不符合协议时按安全错误报告。
      return sentencePracticeStartResultSchema.parse({
        status: 'ok',
        sessionId: outcome.sessionId,
        actualCount: outcome.entries.length,
        entries: outcome.entries
      })
    } catch (error) {
      return { status: 'error', error: toSafeSentencePracticeError(error) }
    }
  }

  const hintsHandler = async (
    event: IpcMainInvokeEvent,
    rawInput: unknown
  ): Promise<SentencePracticeHintsResult> => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = sentencePracticeHintsInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      if (!ownsSession(event, input.data.sessionId)) {
        return { status: 'error', error: { code: 'SESSION_NOT_FOUND' } }
      }
      const hints = await service.generateHints(
        input.data.sessionId,
        input.data.requestId,
        resolveExplanationLanguage(),
        resolvePracticeLanguage()
      )
      return sentencePracticeHintsResultSchema.parse({ status: 'ok', hints })
    } catch (error) {
      return { status: 'error', error: toSafeSentencePracticeError(error) }
    }
  }

  const reviewHandler = async (
    event: IpcMainInvokeEvent,
    rawInput: unknown
  ): Promise<SentencePracticeReviewResult> => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = sentencePracticeReviewInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      if (!ownsSession(event, input.data.sessionId)) {
        return { status: 'error', error: { code: 'SESSION_NOT_FOUND' } }
      }
      const review = await service.review(
        input.data.sessionId,
        input.data.requestId,
        input.data.answer,
        resolveExplanationLanguage(),
        resolvePracticeLanguage()
      )
      return sentencePracticeReviewResultSchema.parse({ status: 'ok', review })
    } catch (error) {
      return { status: 'error', error: toSafeSentencePracticeError(error) }
    }
  }

  const cancelHandler = (
    event: IpcMainInvokeEvent,
    rawInput: unknown
  ): SentencePracticeCancelResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = sentencePracticeCancelInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      if (!ownsSession(event, input.data.sessionId)) {
        return { status: 'ok', cancelled: false }
      }
      return sentencePracticeCancelResultSchema.parse({
        status: 'ok',
        cancelled: service.cancel(input.data.sessionId, input.data.requestId)
      })
    } catch (error) {
      return { status: 'error', error: toSafeSentencePracticeError(error) }
    }
  }

  const closeHandler = (
    event: IpcMainInvokeEvent,
    rawInput: unknown
  ): SentencePracticeCloseResult => {
    if (!isTrustedSource(event, trustedRendererUrl)) {
      return { status: 'error', error: { code: 'UNTRUSTED_SOURCE' } }
    }
    const input = sentencePracticeCloseInputSchema.safeParse(rawInput)
    if (!input.success) {
      return { status: 'error', error: { code: 'INVALID_INPUT' } }
    }
    try {
      if (!ownsSession(event, input.data.sessionId)) {
        return { status: 'ok', closed: false }
      }
      const closed = releaseOwner()
      return sentencePracticeCloseResultSchema.parse({ status: 'ok', closed })
    } catch (error) {
      return { status: 'error', error: toSafeSentencePracticeError(error) }
    }
  }

  ipcMain.handle(SENTENCE_PRACTICE_CHANNELS.start, startHandler)
  ipcMain.handle(SENTENCE_PRACTICE_CHANNELS.hints, hintsHandler)
  ipcMain.handle(SENTENCE_PRACTICE_CHANNELS.review, reviewHandler)
  ipcMain.handle(SENTENCE_PRACTICE_CHANNELS.cancel, cancelHandler)
  ipcMain.handle(SENTENCE_PRACTICE_CHANNELS.close, closeHandler)
  return () => {
    releaseOwner()
    ipcMain.removeHandler(SENTENCE_PRACTICE_CHANNELS.start)
    ipcMain.removeHandler(SENTENCE_PRACTICE_CHANNELS.hints)
    ipcMain.removeHandler(SENTENCE_PRACTICE_CHANNELS.review)
    ipcMain.removeHandler(SENTENCE_PRACTICE_CHANNELS.cancel)
    ipcMain.removeHandler(SENTENCE_PRACTICE_CHANNELS.close)
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
