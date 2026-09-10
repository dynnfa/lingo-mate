// 用量统计的展示格式化与指标口径：墙钟日期只表达日历含义（用 UTC
// 正午承载后按 UTC 格式化，避免宿主时区偏移）；某指标的所有有效调用
// 均未知时显示“未知”，不伪装成确认的 0。
import type { SupportedLocale } from '../../../../shared/preferences'
import type { UsageBucket } from '../../../../shared/usage'

export type UsageMetric = 'input' | 'output' | 'total'

const WALL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseWallDate(
  date: string
): { year: number; month: number; day: number } | undefined {
  const match = WALL_DATE_PATTERN.exec(date)
  if (!match) return undefined
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

function wallDateToUtcNoon(date: string): Date | undefined {
  const parsed = parseWallDate(date)
  if (!parsed) return undefined
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12))
}

export function formatWallDateFull(locale: SupportedLocale, date: string): string {
  const carrier = wallDateToUtcNoon(date)
  if (!carrier) return date
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(carrier)
}

export function formatWallDateCompact(locale: SupportedLocale, date: string): string {
  const carrier = wallDateToUtcNoon(date)
  if (!carrier) return date
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'numeric',
    day: 'numeric'
  }).format(carrier)
}

export function formatWeekRange(
  locale: SupportedLocale,
  startDate: string,
  endDate: string
): string {
  const start = parseWallDate(startDate)
  const end = parseWallDate(endDate)
  if (!start || !end) return `${startDate} – ${endDate}`
  const startCarrier = new Date(Date.UTC(start.year, start.month - 1, start.day, 12))
  const endCarrier = new Date(Date.UTC(end.year, end.month - 1, end.day, 12))
  const sameYear = start.year === end.year
  const startFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric'
  })
  const endFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
  return `${startFormatter.format(startCarrier)} – ${endFormatter.format(endCarrier)}`
}

export function formatTokenNumber(locale: SupportedLocale, value: number): string {
  return new Intl.NumberFormat(locale).format(value)
}

export function formatTokenCompact(locale: SupportedLocale, value: number): string {
  return new Intl.NumberFormat(locale, { notation: 'compact' }).format(value)
}

// 该指标的有效调用（非 invalid）是否全部未知：是则显示“未知”。
export function isUsageMetricUnknown(bucket: UsageBucket, metric: UsageMetric): boolean {
  const contributingRequests = bucket.requestCount - bucket.invalidCount
  if (contributingRequests <= 0) return false
  const unknownCount =
    metric === 'input'
      ? bucket.inputUnknownCount
      : metric === 'output'
        ? bucket.outputUnknownCount
        : bucket.totalUnknownCount
  return unknownCount >= contributingRequests
}

export function usageMetricValue(bucket: UsageBucket, metric: UsageMetric): number {
  return metric === 'input'
    ? bucket.inputTokens
    : metric === 'output'
      ? bucket.outputTokens
      : bucket.totalTokens
}

export function usageMetricUnknownCount(bucket: UsageBucket, metric: UsageMetric): number {
  return metric === 'input'
    ? bucket.inputUnknownCount
    : metric === 'output'
      ? bucket.outputUnknownCount
      : bucket.totalUnknownCount
}

// 空账本判定：30 天与 8 周内均无任何调用记录。
export function isEmptyUsageLedger(overview: {
  days: UsageBucket[]
  weeks: UsageBucket[]
}): boolean {
  return (
    overview.days.every((day) => day.requestCount === 0) &&
    overview.weeks.every((week) => week.requestCount === 0)
  )
}
