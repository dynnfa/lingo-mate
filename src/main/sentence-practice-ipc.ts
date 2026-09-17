import type { WebContents } from 'electron'
import type { RegisterTrustedHandler, TrustedHandlerConfig } from './ipc-guard'
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
  type SentencePracticeError
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

// 注册造句练习 IPC；解释语言与练习语言按请求快照传入。来源检查、输入与
// 结果校验由公共守卫执行；单实例会话所有权与销毁清理由本模块管理。
export function registerSentencePracticeIpc(
  service: SentencePracticeService,
  resolveExplanationLanguage: () => SupportedLocale,
  resolvePracticeLanguage: () => TargetLanguage,
  registerTrustedHandler: RegisterTrustedHandler
): () => void {
  let owner: { sender: WebContents; sessionId: string; onDestroyed: () => void } | undefined

  const releaseOwner = (): boolean => {
    if (!owner) return false
    const previous = owner
    owner = undefined
    previous.sender.removeListener('destroyed', previous.onDestroyed)
    return service.close(previous.sessionId)
  }

  const ownsSession = (sender: WebContents, sessionId: string): boolean =>
    owner?.sender === sender && owner.sessionId === sessionId

  const removeStart = registerTrustedHandler({
    channel: SENTENCE_PRACTICE_CHANNELS.start,
    inputSchema: sentencePracticeStartInputSchema,
    resultSchema: sentencePracticeStartResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeSentencePracticeError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (_input, { sender }) => {
      if (owner && owner.sender !== sender) {
        return { status: 'error', error: { code: 'BUSY' } }
      }
      releaseOwner()
      const outcome = service.start()
      const onDestroyed = (): void => {
        releaseOwner()
      }
      owner = { sender, sessionId: outcome.sessionId, onDestroyed }
      sender.once('destroyed', onDestroyed)
      return {
        status: 'ok',
        sessionId: outcome.sessionId,
        actualCount: outcome.entries.length,
        entries: outcome.entries
      }
    }
  } satisfies TrustedHandlerConfig<
    typeof sentencePracticeStartInputSchema,
    typeof sentencePracticeStartResultSchema
  >)

  const removeHints = registerTrustedHandler({
    channel: SENTENCE_PRACTICE_CHANNELS.hints,
    inputSchema: sentencePracticeHintsInputSchema,
    resultSchema: sentencePracticeHintsResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeSentencePracticeError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: async (input, { sender }) => {
      if (!ownsSession(sender, input.sessionId)) {
        return { status: 'error', error: { code: 'SESSION_NOT_FOUND' } }
      }
      const hints = await service.generateHints(
        input.sessionId,
        input.requestId,
        resolveExplanationLanguage(),
        resolvePracticeLanguage()
      )
      return { status: 'ok', hints }
    }
  } satisfies TrustedHandlerConfig<
    typeof sentencePracticeHintsInputSchema,
    typeof sentencePracticeHintsResultSchema
  >)

  const removeReview = registerTrustedHandler({
    channel: SENTENCE_PRACTICE_CHANNELS.review,
    inputSchema: sentencePracticeReviewInputSchema,
    resultSchema: sentencePracticeReviewResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeSentencePracticeError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: async (input, { sender }) => {
      if (!ownsSession(sender, input.sessionId)) {
        return { status: 'error', error: { code: 'SESSION_NOT_FOUND' } }
      }
      const review = await service.review(
        input.sessionId,
        input.requestId,
        input.answer,
        resolveExplanationLanguage(),
        resolvePracticeLanguage()
      )
      return { status: 'ok', review }
    }
  } satisfies TrustedHandlerConfig<
    typeof sentencePracticeReviewInputSchema,
    typeof sentencePracticeReviewResultSchema
  >)

  const removeCancel = registerTrustedHandler({
    channel: SENTENCE_PRACTICE_CHANNELS.cancel,
    inputSchema: sentencePracticeCancelInputSchema,
    resultSchema: sentencePracticeCancelResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeSentencePracticeError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input, { sender }) => {
      if (!ownsSession(sender, input.sessionId)) {
        return { status: 'ok', cancelled: false }
      }
      return { status: 'ok', cancelled: service.cancel(input.sessionId, input.requestId) }
    }
  } satisfies TrustedHandlerConfig<
    typeof sentencePracticeCancelInputSchema,
    typeof sentencePracticeCancelResultSchema
  >)

  const removeClose = registerTrustedHandler({
    channel: SENTENCE_PRACTICE_CHANNELS.close,
    inputSchema: sentencePracticeCloseInputSchema,
    resultSchema: sentencePracticeCloseResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeSentencePracticeError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input, { sender }) => {
      if (!ownsSession(sender, input.sessionId)) {
        return { status: 'ok', closed: false }
      }
      return { status: 'ok', closed: releaseOwner() }
    }
  } satisfies TrustedHandlerConfig<
    typeof sentencePracticeCloseInputSchema,
    typeof sentencePracticeCloseResultSchema
  >)

  return () => {
    releaseOwner()
    removeStart()
    removeHints()
    removeReview()
    removeCancel()
    removeClose()
  }
}
