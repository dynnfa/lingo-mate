import { z } from 'zod'

// 设置页“用量”统计的 IPC 协议：只允许预定义窗口的聚合读取，
// 不暴露任意时间范围、SQL 或请求明细，敏感数据（密钥、Prompt、
// 原始错误）不跨越进程边界。
export const USAGE_CHANNELS = {
  getOverview: 'usage:getOverview'
} as const

// 请求首版只允许空对象：时区与当前时间由 Main/Core 提供，
// 不接受 Renderer 注入。
export const usageOverviewInputSchema = z.strictObject({})
export type UsageOverviewInput = z.infer<typeof usageOverviewInputSchema>

// 本地墙钟日期（YYYY-MM-DD）：只表达日历含义，由 Core 按请求时区计算，
// Renderer 格式化时不得再用宿主时区重新解释。
const wallDatePattern = /^\d{4}-\d{2}-\d{2}$/

// 单个统计桶（自然日或自然周）：token 合计只包含已知值，
// NULL 与 0 的区分通过 unknown 计数表达；future 表示该桶起点
// 晚于快照时刻，尚未发生。
export const usageBucketSchema = z
  .object({
    key: z.string().min(1),
    startAt: z.number().int().nonnegative(),
    endAt: z.number().int().positive(),
    localStartDate: z.string().regex(wallDatePattern),
    localEndDate: z.string().regex(wallDatePattern),
    requestCount: z.number().int().nonnegative(),
    runningCount: z.number().int().nonnegative(),
    invalidCount: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    inputUnknownCount: z.number().int().nonnegative(),
    outputUnknownCount: z.number().int().nonnegative(),
    totalUnknownCount: z.number().int().nonnegative(),
    future: z.boolean()
  })
  .refine((bucket) => bucket.endAt > bucket.startAt)
export type UsageBucket = z.infer<typeof usageBucketSchema>

// 一次 getOverview 返回同一 asOf/时区下的一致快照：今日/本周摘要、
// 最近 30 个自然日、最近 8 个自然周及每个周的 7 个日桶。
export const usageOverviewSchema = z.object({
  asOf: z.iso.datetime(),
  timeZone: z.string().min(1),
  today: usageBucketSchema,
  thisWeek: usageBucketSchema,
  days: z.array(usageBucketSchema).length(30),
  weeks: z.array(usageBucketSchema).length(8),
  dailyByWeek: z.record(z.string(), z.array(usageBucketSchema).length(7))
})
export type UsageOverview = z.infer<typeof usageOverviewSchema>

export const USAGE_ERROR_CODES = [
  'UNTRUSTED_SOURCE',
  'INVALID_INPUT',
  'USAGE_READ_FAILED',
  'USAGE_OVERFLOW',
  'UNKNOWN_ERROR'
] as const
export type UsageErrorCode = (typeof USAGE_ERROR_CODES)[number]

// 协议只表达安全错误语义；展示文案由 Renderer 按界面语言翻译。
export const usageErrorSchema = z.object({ code: z.enum(USAGE_ERROR_CODES) })
export type UsageError = z.infer<typeof usageErrorSchema>

export const usageOverviewResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), overview: usageOverviewSchema }),
  z.object({ status: z.literal('error'), error: usageErrorSchema })
])
export type UsageOverviewResult = z.infer<typeof usageOverviewResultSchema>

export interface UsageApi {
  getOverview(input: UsageOverviewInput): Promise<UsageOverviewResult>
}
