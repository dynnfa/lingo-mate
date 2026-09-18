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
  return register({
    channel: ERROR_LOG_CHANNELS.report,
    inputSchema: rendererErrorReportSchema,
    rateLimit: {
      maxRequests: options.maxReports ?? DEFAULT_MAX_REPORTS,
      windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
      now: options.now,
      error: { code: 'RATE_LIMITED' }
    },
    resultSchema: errorReportResultSchema,
    invalidInputError: () => ({ code: 'INVALID_REPORT' as const }),
    mapError: () => ({ code: 'INVALID_REPORT' as const }),
    fallbackError: { code: 'INVALID_REPORT' },
    handler: (input: RendererErrorReport): z.output<typeof errorReportResultSchema> => {
      let serialized: string
      try {
        serialized = JSON.stringify(input)
      } catch {
        return { status: 'error', error: { code: 'INVALID_REPORT' } }
      }
      if (Buffer.byteLength(serialized, 'utf8') > ERROR_REPORT_MAX_BYTES) {
        return { status: 'error', error: { code: 'PAYLOAD_TOO_LARGE' } }
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
