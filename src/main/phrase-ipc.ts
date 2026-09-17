import type { RegisterTrustedHandler, TrustedHandlerConfig } from './ipc-guard'
import { PhraseError } from '../core/learning/phrase/parse-phrase-input'
import type { PhraseManagementService } from '../core/learning/phrase/phrase-management'
import {
  deletePhraseInputSchema,
  deletePhraseResultSchema,
  listPhraseInputSchema,
  listPhraseResultSchema,
  PHRASE_CHANNELS,
  type PhraseManagementError
} from '../shared/phrase'

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留管理入口的
// 安全错误码，不携带数据库路径、SQL 或异常堆栈。
export function toSafePhraseManagementError(error: unknown): PhraseManagementError {
  if (error instanceof PhraseError && error.code === 'STORAGE_FAILED') {
    return { code: 'STORAGE_FAILED' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 注册已记录页短语列表与删除 handler；来源检查、输入与结果校验由公共守卫执行。
export function registerPhraseIpc(
  service: PhraseManagementService,
  registerTrustedHandler: RegisterTrustedHandler
): () => void {
  const removeList = registerTrustedHandler({
    channel: PHRASE_CHANNELS.list,
    inputSchema: listPhraseInputSchema,
    resultSchema: listPhraseResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafePhraseManagementError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => {
      const page = service.list(input)
      return {
        status: 'ok',
        entries: page.entries,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      }
    }
  } satisfies TrustedHandlerConfig<typeof listPhraseInputSchema, typeof listPhraseResultSchema>)

  const removeDelete = registerTrustedHandler({
    channel: PHRASE_CHANNELS.delete,
    inputSchema: deletePhraseInputSchema,
    resultSchema: deletePhraseResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafePhraseManagementError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => ({ status: 'ok', ...service.deleteByPhrase(input) })
  } satisfies TrustedHandlerConfig<typeof deletePhraseInputSchema, typeof deletePhraseResultSchema>)

  return () => {
    removeList()
    removeDelete()
  }
}
