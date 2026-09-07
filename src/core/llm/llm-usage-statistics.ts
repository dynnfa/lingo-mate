// LLM 用量统计读取服务：按注入的时钟与时区把账本聚合为自然日/自然周，
// 补齐无调用的空桶并应用完整性规则（已知/未知/异常分离）。
// 周桶由同一份日桶聚合而成，保证日/周口径一致；同一快照内使用同一
// asOf 与时区，快照时刻之后的记录不进入统计。
import type { UsageBucket, UsageOverview } from '../../shared/usage'

export const USAGE_DAILY_WINDOW_DAYS = 30
export const USAGE_WEEKLY_WINDOW_WEEKS = 8
const MS_PER_DAY = 86_400_000
const MAX_SAFE_INTEGER = 9_007_199_254_740_991

export interface LlmUsageBucketWindow {
  startAt: number
  endAt: number
}

// 一个时间桶的聚合结果：token 合计只含非 invalid 记录的已知值，
// 对应 unknown 计数表达“有调用但该指标未知”的请求数。
export interface LlmUsageBucketAggregate {
  requestCount: number
  runningCount: number
  invalidCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  inputUnknownCount: number
  outputUnknownCount: number
  totalUnknownCount: number
}

// 统计读取仓储窄接口：按 [startAt, endAt) 返回聚合，不导出请求明细。
export interface LlmUsageStatisticsStore {
  aggregateBuckets(windows: readonly LlmUsageBucketWindow[]): LlmUsageBucketAggregate[]
}

// 注入时钟与时区来源：测试用固定值；时区每次调用读取，
// 系统时区改变后下次查询按新时区重新归属历史记录。
export interface LlmUsageClock {
  now(): number
  getTimeZone(): string
}

export type LlmUsageStatisticsErrorCode = 'READ_FAILED' | 'OVERFLOW'

export class LlmUsageStatisticsError extends Error {
  constructor(
    readonly code: LlmUsageStatisticsErrorCode,
    options?: { cause?: unknown }
  ) {
    super(`LLM usage statistics failed: ${code}`, options)
    this.name = 'LlmUsageStatisticsError'
  }
}

interface WallDate {
  year: number
  month: number
  day: number
}

const EMPTY_AGGREGATE: LlmUsageBucketAggregate = {
  requestCount: 0,
  runningCount: 0,
  invalidCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputUnknownCount: 0,
  outputUnknownCount: 0,
  totalUnknownCount: 0
}

export class LlmUsageStatisticsService {
  constructor(
    private readonly store: LlmUsageStatisticsStore,
    private readonly clock: LlmUsageClock
  ) {}

  getOverview(): UsageOverview {
    const now = this.clock.now()
    const timeZone = this.clock.getTimeZone()
    if (!Number.isFinite(now)) {
      throw new LlmUsageStatisticsError('READ_FAILED')
    }
    if (!isValidTimeZone(timeZone)) {
      throw new LlmUsageStatisticsError('READ_FAILED')
    }

    const todayIndex = wallDayIndexOf(localWallDate(now, timeZone))
    const mondayIndex = todayIndex - mondayOffsetOfDay(todayIndex)
    // 8 个自然周（含本周）覆盖的日范围最早；30 天窗口必然包含在内。
    const firstDayIndex = mondayIndex - (USAGE_WEEKLY_WINDOW_WEEKS - 1) * 7

    // 查询窗口使用真实日历边界（DST 下天数不是固定 24 小时），
    // 快照时刻之后的记录不计入：查询末端收敛到 now。
    const metas: Array<{ dayIndex: number; startAt: number; endAt: number }> = []
    for (let dayIndex = firstDayIndex; dayIndex <= todayIndex; dayIndex += 1) {
      metas.push({
        dayIndex,
        startAt: wallDayStartUtcMs(dayIndex, timeZone),
        endAt: wallDayStartUtcMs(dayIndex + 1, timeZone)
      })
    }

    let aggregates: LlmUsageBucketAggregate[]
    try {
      aggregates = this.store.aggregateBuckets(
        metas.map((meta) => ({ startAt: meta.startAt, endAt: Math.min(meta.endAt, now) }))
      )
    } catch (error) {
      if (error instanceof LlmUsageStatisticsError) throw error
      throw new LlmUsageStatisticsError('READ_FAILED', { cause: error })
    }
    if (aggregates.length !== metas.length) {
      throw new LlmUsageStatisticsError('READ_FAILED')
    }

    const bucketByDayIndex = new Map<number, UsageBucket>()
    metas.forEach((meta, i) => {
      const aggregate = validateAggregate(aggregates[i])
      const wallDate = dayIndexToWallDate(meta.dayIndex)
      bucketByDayIndex.set(
        meta.dayIndex,
        dayBucket(meta.startAt, meta.endAt, wallDate, aggregate, now)
      )
    })

    const dayBucketAt = (dayIndex: number): UsageBucket => {
      const existing = bucketByDayIndex.get(dayIndex)
      if (existing) return existing
      // 本周尚未发生的日期：补齐为 future 空桶，不画成已完成的零用量日。
      const startAt = wallDayStartUtcMs(dayIndex, timeZone)
      const endAt = wallDayStartUtcMs(dayIndex + 1, timeZone)
      return dayBucket(startAt, endAt, dayIndexToWallDate(dayIndex), EMPTY_AGGREGATE, now)
    }

    const weeks: UsageBucket[] = []
    const dailyByWeek: Record<string, UsageBucket[]> = {}
    for (let weekOffset = USAGE_WEEKLY_WINDOW_WEEKS - 1; weekOffset >= 0; weekOffset -= 1) {
      const weekStartIndex = mondayIndex - weekOffset * 7
      const days = range(0, 7).map((i) => dayBucketAt(weekStartIndex + i))
      const week = combineBuckets(days, weekStartIndex, now)
      weeks.push(week)
      dailyByWeek[week.key] = days
    }

    const days = range(0, USAGE_DAILY_WINDOW_DAYS).map((i) =>
      dayBucketAt(todayIndex - (USAGE_DAILY_WINDOW_DAYS - 1) + i)
    )
    const today = dayBucketAt(todayIndex)
    const thisWeek = weeks[weeks.length - 1]

    return {
      asOf: new Date(now).toISOString(),
      timeZone,
      today,
      thisWeek,
      days,
      weeks,
      dailyByWeek
    }
  }
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i)
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

function localWallDate(utcMs: number, timeZone: string): WallDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(utcMs))
  const valueOf = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  return { year: valueOf('year'), month: valueOf('month'), day: valueOf('day') }
}

// 某时刻该时区的偏移量（本地墙钟 - UTC），用于把墙钟午夜换算为 UTC 瞬时。
function timeZoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(utcMs))
  const valueOf = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  const wallAsUtc = Date.UTC(
    valueOf('year'),
    valueOf('month') - 1,
    valueOf('day'),
    valueOf('hour'),
    valueOf('minute'),
    valueOf('second')
  )
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000
}

// 墙钟日期的当天起点（UTC 毫秒）：迭代两次消除 DST 边界附近的偏移抖动，
// 不假设每个本地日固定为 24 小时。
function wallDayStartUtcMs(dayIndex: number, timeZone: string): number {
  const wallMidnightAsUtc = dayIndex * MS_PER_DAY
  let utc = wallMidnightAsUtc - timeZoneOffsetMs(timeZone, wallMidnightAsUtc)
  utc = wallMidnightAsUtc - timeZoneOffsetMs(timeZone, utc)
  return utc
}

function wallDayIndexOf(wallDate: WallDate): number {
  return Math.round(Date.UTC(wallDate.year, wallDate.month - 1, wallDate.day) / MS_PER_DAY)
}

function dayIndexToWallDate(dayIndex: number): WallDate {
  const utc = new Date(dayIndex * MS_PER_DAY)
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
}

// 周一律为 0：星期是日历属性，用墙钟日期按 UTC 计算即可。
function mondayOffsetOfDay(dayIndex: number): number {
  const weekday = new Date(dayIndex * MS_PER_DAY).getUTCDay()
  return (weekday + 6) % 7
}

function formatWallDate(wallDate: WallDate): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(wallDate.year).padStart(4, '0')}-${pad(wallDate.month)}-${pad(wallDate.day)}`
}

function addDays(date: WallDate, days: number): WallDate {
  return dayIndexToWallDate(wallDayIndexOf(date) + days)
}

function dayBucket(
  startAt: number,
  endAt: number,
  wallDate: WallDate,
  aggregate: LlmUsageBucketAggregate,
  now: number
): UsageBucket {
  const localStartDate = formatWallDate(wallDate)
  return {
    key: `day:${localStartDate}`,
    startAt,
    endAt,
    localStartDate,
    localEndDate: localStartDate,
    ...aggregate,
    future: startAt > now
  }
}

// 周桶由同一份日桶聚合，保证“每周总量 = 该周每日已知总量之和”。
function combineBuckets(days: UsageBucket[], weekStartIndex: number, now: number): UsageBucket {
  const startWall = dayIndexToWallDate(weekStartIndex)
  const localStartDate = formatWallDate(startWall)
  return {
    key: `week:${localStartDate}`,
    startAt: days[0].startAt,
    endAt: days[days.length - 1].endAt,
    localStartDate,
    localEndDate: formatWallDate(addDays(startWall, 6)),
    requestCount: safeSum(days, 'requestCount'),
    runningCount: safeSum(days, 'runningCount'),
    invalidCount: safeSum(days, 'invalidCount'),
    inputTokens: safeSum(days, 'inputTokens'),
    outputTokens: safeSum(days, 'outputTokens'),
    totalTokens: safeSum(days, 'totalTokens'),
    inputUnknownCount: safeSum(days, 'inputUnknownCount'),
    outputUnknownCount: safeSum(days, 'outputUnknownCount'),
    totalUnknownCount: safeSum(days, 'totalUnknownCount'),
    future: days[0].startAt > now
  }
}

function safeSum(days: UsageBucket[], field: keyof UsageBucket): number {
  return days.reduce((acc, day) => safeAdd(acc, day[field] as number), 0)
}

// 聚合溢出返回安全统计错误，不悄悄舍入。
function safeAdd(a: number, b: number): number {
  const sum = a + b
  if (!Number.isSafeInteger(sum) || sum > MAX_SAFE_INTEGER) {
    throw new LlmUsageStatisticsError('OVERFLOW')
  }
  return sum
}

function validateAggregate(aggregate: LlmUsageBucketAggregate): LlmUsageBucketAggregate {
  for (const value of Object.values(aggregate)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new LlmUsageStatisticsError('READ_FAILED')
    }
  }
  return aggregate
}
