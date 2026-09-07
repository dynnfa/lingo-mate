import { describe, expect, it } from 'vitest'
import {
  LlmUsageStatisticsError,
  LlmUsageStatisticsService,
  USAGE_DAILY_WINDOW_DAYS,
  USAGE_WEEKLY_WINDOW_WEEKS,
  type LlmUsageBucketAggregate,
  type LlmUsageBucketWindow,
  type LlmUsageClock,
  type LlmUsageStatisticsStore
} from '../llm-usage-statistics'

const EMPTY: LlmUsageBucketAggregate = {
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

// 按窗口起点映射聚合；未配置的窗口返回空桶，模拟“无调用的已发生日期补 0”。
function fakeStore(
  aggregatesByStartAt: Record<number, LlmUsageBucketAggregate> = {},
  options: { throwsWith?: Error; resultLengthOffset?: number } = {}
): LlmUsageStatisticsStore & { windows: LlmUsageBucketWindow[] } {
  const windows: LlmUsageBucketWindow[] = []
  return {
    windows,
    aggregateBuckets(query) {
      if (options.throwsWith) throw options.throwsWith
      windows.push(...query.map((window) => ({ ...window })))
      const results = query.map((window) => aggregatesByStartAt[window.startAt] ?? EMPTY)
      return results.slice(0, results.length + (options.resultLengthOffset ?? 0))
    }
  }
}

function clock(now: number, timeZone: string): LlmUsageClock {
  return { now: () => now, getTimeZone: () => timeZone }
}

// 2026-09-07 是周一；Asia/Shanghai 固定 UTC+8、无夏令时。
const SHANGHAI_MONDAY_NOON_UTC = Date.UTC(2026, 8, 7, 4, 30)
const SHANGHAI_DAY_START = (y: number, m: number, d: number): number =>
  Date.UTC(y, m - 1, d) - 8 * 3_600_000

describe('LlmUsageStatisticsService', () => {
  it('builds the 30-day and 8-week windows for a fixed Monday snapshot', () => {
    const now = SHANGHAI_MONDAY_NOON_UTC
    const store = fakeStore()
    const overview = new LlmUsageStatisticsService(store, clock(now, 'Asia/Shanghai')).getOverview()

    expect(overview.asOf).toBe(new Date(now).toISOString())
    expect(overview.timeZone).toBe('Asia/Shanghai')

    expect(overview.days).toHaveLength(USAGE_DAILY_WINDOW_DAYS)
    expect(overview.days[0].localStartDate).toBe('2026-08-09')
    expect(overview.days[USAGE_DAILY_WINDOW_DAYS - 1].localStartDate).toBe('2026-09-07')
    expect(overview.days[0].startAt).toBe(SHANGHAI_DAY_START(2026, 8, 9))
    expect(overview.days[29].startAt).toBe(SHANGHAI_DAY_START(2026, 9, 7))
    expect(overview.days[29].endAt).toBe(SHANGHAI_DAY_START(2026, 9, 8))

    expect(overview.weeks).toHaveLength(USAGE_WEEKLY_WINDOW_WEEKS)
    expect(overview.weeks.map((week) => week.localStartDate)).toEqual([
      '2026-07-20',
      '2026-07-27',
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
      '2026-09-07'
    ])
    // 周从周一开始，localEndDate 为周日
    expect(overview.weeks[7].localEndDate).toBe('2026-09-13')
    // 查询窗口覆盖 8 周（56 天中的前 50 天）且不含快照时刻之后的记录
    expect(store.windows).toHaveLength(50)
    expect(store.windows[0].startAt).toBe(SHANGHAI_DAY_START(2026, 7, 20))
    for (const window of store.windows) {
      expect(window.endAt).toBeLessThanOrEqual(now)
    }
    // 今天的窗口末端收敛到快照时刻
    expect(store.windows[store.windows.length - 1].endAt).toBe(now)
  })

  it('fills future days of the current week as marked empty buckets', () => {
    const now = SHANGHAI_MONDAY_NOON_UTC
    const overview = new LlmUsageStatisticsService(
      fakeStore(),
      clock(now, 'Asia/Shanghai')
    ).getOverview()

    const currentWeekDays = overview.dailyByWeek['week:2026-09-07']
    expect(currentWeekDays).toHaveLength(7)
    expect(currentWeekDays.map((day) => day.localStartDate)).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13'
    ])
    expect(currentWeekDays[0].future).toBe(false)
    for (const day of currentWeekDays.slice(1)) {
      expect(day.future).toBe(true)
      expect(day.requestCount).toBe(0)
    }
    for (const week of overview.weeks) {
      expect(overview.dailyByWeek[week.key]).toHaveLength(7)
    }
  })

  it('aggregates weeks and summaries from the same day buckets', () => {
    const now = SHANGHAI_MONDAY_NOON_UTC
    const mondayStart = SHANGHAI_DAY_START(2026, 9, 7)
    // 9 月 5 日（周六）与 9 月 6 日（周日）属于上一个自然周
    const saturdayStart = SHANGHAI_DAY_START(2026, 9, 5)
    const sundayStart = SHANGHAI_DAY_START(2026, 9, 6)
    const store = fakeStore({
      [mondayStart]: {
        requestCount: 2,
        runningCount: 0,
        invalidCount: 0,
        inputTokens: 300,
        outputTokens: 60,
        totalTokens: 360,
        inputUnknownCount: 0,
        outputUnknownCount: 0,
        totalUnknownCount: 0
      },
      [saturdayStart]: {
        requestCount: 1,
        runningCount: 1,
        invalidCount: 1,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        inputUnknownCount: 0,
        outputUnknownCount: 1,
        totalUnknownCount: 0
      },
      [sundayStart]: {
        requestCount: 1,
        runningCount: 0,
        invalidCount: 0,
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        inputUnknownCount: 0,
        outputUnknownCount: 0,
        totalUnknownCount: 0
      }
    })
    const overview = new LlmUsageStatisticsService(store, clock(now, 'Asia/Shanghai')).getOverview()

    // 今日摘要即当天的日桶
    expect(overview.today.requestCount).toBe(2)
    expect(overview.today.totalTokens).toBe(360)
    // 本周 = 该周每日合计（同一次日桶聚合）
    expect(overview.thisWeek.requestCount).toBe(2)
    expect(overview.thisWeek.totalTokens).toBe(360)
    // 上一周包含周六与周日的数据
    expect(overview.weeks[6].requestCount).toBe(2)
    expect(overview.weeks[6].runningCount).toBe(1)
    expect(overview.weeks[6].invalidCount).toBe(1)
    expect(overview.weeks[6].inputTokens).toBe(150)
    expect(overview.weeks[6].outputTokens).toBe(50)
    expect(overview.weeks[6].totalTokens).toBe(200)
    expect(overview.weeks[6].outputUnknownCount).toBe(1)
    // 周桶等于其 7 个日桶之和
    for (const week of overview.weeks) {
      const weekSum = overview.dailyByWeek[week.key].reduce((acc, day) => acc + day.totalTokens, 0)
      expect(week.totalTokens).toBe(weekSum)
    }
    // 无调用的已发生日期补齐为 0（days[26] = 9 月 4 日，未写入聚合）
    expect(overview.days[26].localStartDate).toBe('2026-09-04')
    expect(overview.days[26].requestCount).toBe(0)
    expect(overview.days[26].totalTokens).toBe(0)
    expect(overview.days[26].future).toBe(false)
  })

  it('uses calendar day boundaries across DST transitions instead of fixed 24h days', () => {
    // 美东 2026-03-08 春令时（23 小时日）、2026-11-01 秋令时（25 小时日）
    const spring = Date.UTC(2026, 2, 10, 15, 0)
    const springOverview = new LlmUsageStatisticsService(
      fakeStore(),
      clock(spring, 'America/New_York')
    ).getOverview()
    const springDays = springOverview.days.map((day) => day.localStartDate)
    expect(springDays).toContain('2026-03-08')
    const dstDay = springOverview.days[springDays.indexOf('2026-03-08')]
    expect(dstDay.startAt).toBe(Date.UTC(2026, 2, 8, 5))
    expect(dstDay.endAt).toBe(Date.UTC(2026, 2, 9, 4))
    const normalDay = springOverview.days[springDays.indexOf('2026-03-07')]
    expect(normalDay.endAt - normalDay.startAt).toBe(86_400_000)

    const fall = Date.UTC(2026, 10, 4, 15, 0)
    const fallOverview = new LlmUsageStatisticsService(
      fakeStore(),
      clock(fall, 'America/New_York')
    ).getOverview()
    const fallDays = fallOverview.days.map((day) => day.localStartDate)
    const longDay = fallOverview.days[fallDays.indexOf('2026-11-01')]
    expect(longDay.startAt).toBe(Date.UTC(2026, 10, 1, 4))
    expect(longDay.endAt).toBe(Date.UTC(2026, 10, 2, 5))
    expect(longDay.endAt - longDay.startAt).toBe(25 * 3_600_000)
  })

  it('attributes days and weeks by the requested time zone', () => {
    // 同一时刻：Kiribati（UTC+14）已进入周一，纽约仍是周日晚
    const instant = Date.UTC(2026, 8, 6, 10, 0)
    const kiribati = new LlmUsageStatisticsService(
      fakeStore(),
      clock(instant, 'Pacific/Kiritimati')
    ).getOverview()
    expect(kiribati.today.localStartDate).toBe('2026-09-07')
    expect(kiribati.weeks[7].localStartDate).toBe('2026-09-07')

    const newYork = new LlmUsageStatisticsService(
      fakeStore(),
      clock(instant, 'America/New_York')
    ).getOverview()
    expect(newYork.today.localStartDate).toBe('2026-09-06')
    expect(newYork.weeks[7].localStartDate).toBe('2026-08-31')
  })

  it('throws a safe overflow error when aggregating exceeds safe integers', () => {
    const now = SHANGHAI_MONDAY_NOON_UTC
    const maxAggregate: LlmUsageBucketAggregate = {
      ...EMPTY,
      requestCount: 1,
      totalTokens: Number.MAX_SAFE_INTEGER
    }
    // 同一周内的两天都达到安全整数上限：聚合必然溢出
    const store = fakeStore({
      [SHANGHAI_DAY_START(2026, 9, 5)]: maxAggregate,
      [SHANGHAI_DAY_START(2026, 9, 6)]: maxAggregate
    })
    try {
      new LlmUsageStatisticsService(store, clock(now, 'Asia/Shanghai')).getOverview()
      expect.unreachable('getOverview should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(LlmUsageStatisticsError)
      expect((error as LlmUsageStatisticsError).code).toBe('OVERFLOW')
    }
  })

  it('maps storage failures and invalid clock inputs to READ_FAILED with the cause kept', () => {
    const now = SHANGHAI_MONDAY_NOON_UTC
    const boom = new Error('sqlite closed')
    const failing = new LlmUsageStatisticsService(
      fakeStore({}, { throwsWith: boom }),
      clock(now, 'Asia/Shanghai')
    )
    try {
      failing.getOverview()
      expect.unreachable('getOverview should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(LlmUsageStatisticsError)
      expect((error as LlmUsageStatisticsError).code).toBe('READ_FAILED')
      expect((error as LlmUsageStatisticsError).cause).toBe(boom)
    }

    const mismatched = new LlmUsageStatisticsService(
      fakeStore({}, { resultLengthOffset: -1 }),
      clock(now, 'Asia/Shanghai')
    )
    expect(() => mismatched.getOverview()).toThrowError(LlmUsageStatisticsError)

    const invalidTimeZone = new LlmUsageStatisticsService(fakeStore(), clock(now, 'Mars/Olympus'))
    expect(() => invalidTimeZone.getOverview()).toThrowError(LlmUsageStatisticsError)
  })

  it('rejects aggregates that are not safe non-negative integers', () => {
    const now = SHANGHAI_MONDAY_NOON_UTC
    const poisoned = fakeStore({
      [SHANGHAI_DAY_START(2026, 9, 7)]: { ...EMPTY, totalTokens: -1 }
    })
    expect(() =>
      new LlmUsageStatisticsService(poisoned, clock(now, 'Asia/Shanghai')).getOverview()
    ).toThrowError(LlmUsageStatisticsError)
  })
})
