import type { RegisterTrustedHandler, TrustedHandlerConfig } from './ipc-guard'
import {
  LlmUsageStatisticsError,
  type LlmUsageStatisticsService
} from '../core/llm/llm-usage-statistics'
import {
  USAGE_CHANNELS,
  usageOverviewInputSchema,
  usageOverviewResultSchema,
  type UsageError
} from '../shared/usage'

// 在进程边界把 Core 错误转换为对用户安全的结构：只保留错误码，
// 不携带内部原因；文案由 Renderer 翻译。
export function toSafeUsageError(error: unknown): UsageError {
  if (error instanceof LlmUsageStatisticsError) {
    return { code: error.code === 'OVERFLOW' ? 'USAGE_OVERFLOW' : 'USAGE_READ_FAILED' }
  }
  return { code: 'UNKNOWN_ERROR' }
}

// 注册用量统计读取 handler；来源检查、输入与结果校验由公共守卫执行。
export function registerUsageIpc(
  service: LlmUsageStatisticsService,
  registerTrustedHandler: RegisterTrustedHandler
): () => void {
  return registerTrustedHandler({
    channel: USAGE_CHANNELS.getOverview,
    inputSchema: usageOverviewInputSchema,
    resultSchema: usageOverviewResultSchema,
    invalidInputError: () => ({ code: 'INVALID_INPUT' }),
    mapError: toSafeUsageError,
    fallbackError: { code: 'UNKNOWN_ERROR' },
    handler: () => ({ status: 'ok', overview: service.getOverview() })
  } satisfies TrustedHandlerConfig<
    typeof usageOverviewInputSchema,
    typeof usageOverviewResultSchema
  >)
}
