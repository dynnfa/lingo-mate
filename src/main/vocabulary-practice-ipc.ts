import type { RegisterTrustedHandler, TrustedHandlerConfig } from './ipc-guard'
import type { SupportedLocale } from '../shared/preferences'
import {
  vocabularyPracticeCancelInputSchema,
  vocabularyPracticeCancelResultSchema,
  vocabularyPracticeReviewInputSchema,
  vocabularyPracticeReviewResultSchema,
  vocabularyPracticeStartInputSchema,
  vocabularyPracticeStartResultSchema,
  VOCABULARY_PRACTICE_CHANNELS,
  type VocabularyPracticeError
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
// 来源检查、输入与结果校验由公共守卫执行；练习生命周期由服务自身管理。
export function registerVocabularyPracticeIpc(
  service: VocabularyPracticeService,
  resolveExplanationLanguage: () => SupportedLocale,
  registerTrustedHandler: RegisterTrustedHandler
): () => void {
  const removeStart = registerTrustedHandler({
    channel: VOCABULARY_PRACTICE_CHANNELS.start,
    inputSchema: vocabularyPracticeStartInputSchema,
    resultSchema: vocabularyPracticeStartResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeVocabularyPracticeError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => {
      const outcome = service.start(input.count)
      return {
        status: 'ok',
        sessionId: outcome.sessionId,
        requestedCount: outcome.requestedCount,
        actualCount: outcome.entries.length,
        entries: outcome.entries
      }
    }
  } satisfies TrustedHandlerConfig<
    typeof vocabularyPracticeStartInputSchema,
    typeof vocabularyPracticeStartResultSchema
  >)

  const removeReview = registerTrustedHandler({
    channel: VOCABULARY_PRACTICE_CHANNELS.review,
    inputSchema: vocabularyPracticeReviewInputSchema,
    resultSchema: vocabularyPracticeReviewResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeVocabularyPracticeError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: async (input) => {
      const outcome = await service.review(
        input.sessionId,
        input.answers,
        resolveExplanationLanguage()
      )
      return {
        status: 'ok',
        verdict: outcome.verdict,
        summary: outcome.summary,
        marks: outcome.marks
      }
    }
  } satisfies TrustedHandlerConfig<
    typeof vocabularyPracticeReviewInputSchema,
    typeof vocabularyPracticeReviewResultSchema
  >)

  const removeCancel = registerTrustedHandler({
    channel: VOCABULARY_PRACTICE_CHANNELS.cancel,
    inputSchema: vocabularyPracticeCancelInputSchema,
    resultSchema: vocabularyPracticeCancelResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeVocabularyPracticeError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => ({ status: 'ok', cancelled: service.cancel(input.sessionId) })
  } satisfies TrustedHandlerConfig<
    typeof vocabularyPracticeCancelInputSchema,
    typeof vocabularyPracticeCancelResultSchema
  >)

  return () => {
    removeStart()
    removeReview()
    removeCancel()
  }
}
