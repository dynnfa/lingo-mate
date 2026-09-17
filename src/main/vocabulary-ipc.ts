import type { RegisterTrustedHandler, TrustedHandlerConfig } from './ipc-guard'
import { VocabularyError } from '../core/learning/vocabulary/parse-vocabulary-input'
import type { VocabularyManagementService } from '../core/learning/vocabulary/vocabulary-management'
import {
  deleteVocabularyInputSchema,
  deleteVocabularyResultSchema,
  listVocabularyInputSchema,
  listVocabularyResultSchema,
  VOCABULARY_CHANNELS,
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

// 注册已记录页词汇列表与删除 handler；来源检查、输入与结果校验由公共守卫执行。
export function registerVocabularyIpc(
  service: VocabularyManagementService,
  registerTrustedHandler: RegisterTrustedHandler
): () => void {
  const removeList = registerTrustedHandler({
    channel: VOCABULARY_CHANNELS.list,
    inputSchema: listVocabularyInputSchema,
    resultSchema: listVocabularyResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeVocabularyManagementError,
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
    typeof listVocabularyInputSchema,
    typeof listVocabularyResultSchema
  >)

  const removeDelete = registerTrustedHandler({
    channel: VOCABULARY_CHANNELS.delete,
    inputSchema: deleteVocabularyInputSchema,
    resultSchema: deleteVocabularyResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeVocabularyManagementError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => ({ status: 'ok', ...service.deleteById(input) })
  } satisfies TrustedHandlerConfig<
    typeof deleteVocabularyInputSchema,
    typeof deleteVocabularyResultSchema
  >)

  return () => {
    removeList()
    removeDelete()
  }
}
