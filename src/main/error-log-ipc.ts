import type { ErrorLogger } from './error-logger'
import type { RegisterTrustedHandler } from './ipc-guard'
import { z } from 'zod'
import {
  ERROR_LOG_CHANNELS,
  ERROR_REPORT_MAX_BYTES,
  errorReportResultSchema,
  rendererErrorReportSchema,
  type RendererErrorReport
} from '../shared/error-report'

export interface ErrorReportIpcOptions {
  now?: () => number
  maxReports?: number
  windowMs?: number
}

const DEFAULT_MAX_REPORTS = 30
const DEFAULT_WINDOW_MS = 10_000

interface RateLimitState {
  timestamps: number[]
  warnedAt: number
}

/**
 * 注册 Renderer/Preload 的受限错误上报入口。复用 IPC 守卫的可信来源校验
 * 与输入 schema；Main 生成时间戳，不信任载荷里的任何身份或路径字段。
 * 上报失败或日志服务异常都不会向 Renderer 抛错，避免上报循环。
 */
export function registerErrorReportIpc(
  logger: ErrorLogger,
  register: RegisterTrustedHandler,
  options: ErrorReportIpcOptions = {}
): () => void {
  const maxReports = options.maxReports ?? DEFAULT_MAX_REPORTS
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const now = options.now ?? (() => Date.now())
  const limits = new Map<number, RateLimitState>()

  const isRateLimited = (senderId: number): boolean => {
    const state = limits.get(senderId) ?? { timestamps: [], warnedAt: 0 }
    const at = now()
    state.timestamps = state.timestamps.filter((stamp) => at - stamp < windowMs)
    if (state.timestamps.length >= maxReports) {
      limits.set(senderId, state)
      // 限频本身也限频告警：一个窗口内最多记录一次，且只含安全元信息。
      if (at - state.warnedAt >= windowMs) {
        state.warnedAt = at
        logger.log({
          level: 'warn',
          source: 'renderer',
          module: 'error-report',
          operation: 'rate-limit',
          code: 'RATE_LIMITED',
          message: 'renderer error reports exceeded the rate limit and were dropped'
        })
      }
      return true
    }
    state.timestamps.push(at)
    limits.set(senderId, state)
    return false
  }

  return register({
    channel: ERROR_LOG_CHANNELS.report,
    inputSchema: rendererErrorReportSchema,
    resultSchema: errorReportResultSchema,
    invalidInputError: () => ({ code: 'INVALID_REPORT' as const }),
    mapError: () => ({ code: 'INVALID_REPORT' as const }),
    fallbackError: { code: 'INVALID_REPORT' },
    handler: (input: RendererErrorReport, context): z.output<typeof errorReportResultSchema> => {
      let serialized: string
      try {
        serialized = JSON.stringify(input)
      } catch {
        return { status: 'error', error: { code: 'INVALID_REPORT' } }
      }
      if (Buffer.byteLength(serialized, 'utf8') > ERROR_REPORT_MAX_BYTES) {
        return { status: 'error', error: { code: 'PAYLOAD_TOO_LARGE' } }
      }
      if (isRateLimited(context.sender.id)) {
        return { status: 'error', error: { code: 'RATE_LIMITED' } }
      }
      try {
        logger.log({
          source: input.source,
          module: input.module,
          operation: input.operation,
          code: input.code,
          message: input.message,
          error:
            input.stack === undefined ? undefined : { name: 'ReportedError', stack: input.stack },
          context: input.context
        })
      } catch {
        // 日志服务自身异常不影响上报结果，也不再次触发上报。
      }
      return { status: 'ok' }
    }
  })
}
