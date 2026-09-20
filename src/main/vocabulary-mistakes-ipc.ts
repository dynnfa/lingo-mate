import type { RegisterTrustedHandler, TrustedHandlerConfig } from './ipc-guard'
import { VocabularyMistakesError } from '../core/learning/vocabulary-practice/parse-vocabulary-mistakes-input'
import type { VocabularyMistakeQueryService } from '../core/learning/vocabulary-practice/vocabulary-mistake-query-service'
import {
  listVocabularyMistakeHistoryInputSchema,
  listVocabularyMistakeHistoryResultSchema,
  listVocabularyMistakesInputSchema,
  listVocabularyMistakesResultSchema,
  VOCABULARY_MISTAKES_CHANNELS,
  type VocabularyMistakesError as SafeVocabularyMistakesError
} from '../shared/vocabulary-mistakes'

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留错题查询协议的
// 安全错误码，不携带数据库路径、SQL 或异常堆栈。
export function toSafeVocabularyMistakesError(error: unknown): SafeVocabularyMistakesError {
  if (error instanceof VocabularyMistakesError) return { code: error.code }
  return { code: 'UNKNOWN_ERROR' }
}

// 注册错题集只读查询 IPC；来源检查、输入与结果校验由公共守卫执行，
// 聚合与历史分页在仓储完成。
export function registerVocabularyMistakesIpc(
  service: VocabularyMistakeQueryService,
  registerTrustedHandler: RegisterTrustedHandler
): () => void {
  const removeList = registerTrustedHandler({
    channel: VOCABULARY_MISTAKES_CHANNELS.list,
    inputSchema: listVocabularyMistakesInputSchema,
    resultSchema: listVocabularyMistakesResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeVocabularyMistakesError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => {
      const page = service.list(input)
      return {
        status: 'ok',
        entries: page.entries,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      }
    }
  } satisfies TrustedHandlerConfig<
    typeof listVocabularyMistakesInputSchema,
    typeof listVocabularyMistakesResultSchema
  >)

  const removeHistory = registerTrustedHandler({
    channel: VOCABULARY_MISTAKES_CHANNELS.listHistory,
    inputSchema: listVocabularyMistakeHistoryInputSchema,
    resultSchema: listVocabularyMistakeHistoryResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeVocabularyMistakesError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => {
      const page = service.listHistory(input)
      return {
        status: 'ok',
        items: page.items,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      }
    }
  } satisfies TrustedHandlerConfig<
    typeof listVocabularyMistakeHistoryInputSchema,
    typeof listVocabularyMistakeHistoryResultSchema
  >)

  return () => {
    removeList()
    removeHistory()
  }
}
