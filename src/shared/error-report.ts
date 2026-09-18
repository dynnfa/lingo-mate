import { z } from 'zod'

// Renderer/Preload → Main 的受限错误上报协议。Main 侧生成可信时间戳并
// 复用 IPC 来源校验；载荷不接受 Renderer 提供的时间、路径或进程身份，
// 只承载“哪里发生了什么错误”的最小诊断字段。

export const ERROR_LOG_CHANNELS = {
  report: 'error-log:report'
} as const

export const ERROR_REPORT_MAX_MESSAGE_LENGTH = 2000
export const ERROR_REPORT_MAX_STACK_LENGTH = 8000
// 上报载荷序列化后的字节上限：超过直接拒绝，不进入日志序列化。
export const ERROR_REPORT_MAX_BYTES = 16 * 1024

export const rendererErrorReportSchema = z.strictObject({
  // preload 与 renderer 同进程；此字段只标记捕获层，不承载任何权限语义。
  source: z.enum(['renderer', 'preload']),
  module: z.string().min(1).max(100).optional(),
  operation: z.string().min(1).max(100).optional(),
  code: z.string().min(1).max(100).optional(),
  message: z.string().min(1).max(ERROR_REPORT_MAX_MESSAGE_LENGTH),
  stack: z.string().max(ERROR_REPORT_MAX_STACK_LENGTH).optional(),
  context: z.unknown().optional()
})

export type RendererErrorReport = z.output<typeof rendererErrorReportSchema>

export const errorReportResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({
    status: z.literal('error'),
    error: z.object({
      // UNTRUSTED_SOURCE 是 IPC 守卫的固定拒绝结果，必须能通过本协议校验。
      code: z.enum(['UNTRUSTED_SOURCE', 'INVALID_REPORT', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED'])
    })
  })
])

export type ErrorReportResult = z.output<typeof errorReportResultSchema>

export interface ErrorReportApi {
  reportError(report: RendererErrorReport): Promise<ErrorReportResult>
}
