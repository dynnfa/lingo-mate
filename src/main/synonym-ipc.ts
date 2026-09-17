import type { RegisterTrustedHandler, TrustedHandlerConfig } from './ipc-guard'
import { SynonymError } from '../core/learning/synonym/parse-synonym-input'
import type { SynonymManagementService } from '../core/learning/synonym/synonym-management'
import {
  SYNONYM_CHANNELS,
  synonymListInputSchema,
  synonymListResultSchema,
  type SynonymManagementError
} from '../shared/synonym'

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留管理入口的
// 安全错误码，不携带数据库路径、SQL 或异常堆栈。
export function toSafeSynonymManagementError(error: unknown): SynonymManagementError {
  if (error instanceof SynonymError && error.code === 'STORAGE_FAILED') {
    return { code: 'STORAGE_FAILED' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 注册已记录页近义词分组列表 handler；来源检查、输入与结果校验由公共守卫执行。
export function registerSynonymIpc(
  service: SynonymManagementService,
  registerTrustedHandler: RegisterTrustedHandler
): () => void {
  return registerTrustedHandler({
    channel: SYNONYM_CHANNELS.list,
    inputSchema: synonymListInputSchema,
    resultSchema: synonymListResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeSynonymManagementError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: (input) => {
      const page = service.list(input)
      return { status: 'ok', groups: page.groups, nextCursor: page.nextCursor }
    }
  } satisfies TrustedHandlerConfig<typeof synonymListInputSchema, typeof synonymListResultSchema>)
}
