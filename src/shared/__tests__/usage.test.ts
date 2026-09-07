import { describe, expect, it } from 'vitest'
import {
  USAGE_CHANNELS,
  USAGE_ERROR_CODES,
  usageOverviewInputSchema,
  usageOverviewResultSchema,
  usageOverviewSchema,
  type UsageBucket,
  type UsageOverview
} from '../usage'

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    key: 'day:2026-09-07',
    startAt: 1_000,
    endAt: 86_401_000,
    localStartDate: '2026-09-07',
    localEndDate: '2026-09-07',
    requestCount: 1,
    runningCount: 0,
    invalidCount: 0,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    inputUnknownCount: 0,
    outputUnknownCount: 0,
    totalUnknownCount: 0,
    future: false,
    ...overrides
  }
}

function overviewFixture(): UsageOverview {
  const days = Array.from({ length: 30 }, (_, i) =>
    bucket({ key: `day:${i}`, startAt: i * 86_400_000, endAt: (i + 1) * 86_400_000 })
  )
  const weeks = Array.from({ length: 8 }, (_, i) =>
    bucket({
      key: `week:${i}`,
      localEndDate: '2026-09-13',
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    })
  )
  const dailyByWeek: Record<string, UsageBucket[]> = {}
  for (const week of weeks) {
    dailyByWeek[week.key] = Array.from({ length: 7 }, (_, i) =>
      bucket({ key: `${week.key}/${i}`, future: i > 0 })
    )
  }
  return {
    asOf: '2026-09-07T04:30:00.000Z',
    timeZone: 'Asia/Shanghai',
    today: days[29],
    thisWeek: weeks[7],
    days,
    weeks,
    dailyByWeek
  }
}

describe('usage protocol schemas', () => {
  it('defines the overview channel and safe error codes', () => {
    expect(USAGE_CHANNELS.getOverview).toBe('usage:getOverview')
    expect(USAGE_ERROR_CODES).toContain('UNTRUSTED_SOURCE')
    expect(USAGE_ERROR_CODES).toContain('USAGE_OVERFLOW')
  })

  it('accepts only the predefined empty request payload', () => {
    expect(usageOverviewInputSchema.safeParse({}).success).toBe(true)
    expect(usageOverviewInputSchema.safeParse({ from: '2026-01-01' }).success).toBe(false)
    expect(usageOverviewInputSchema.safeParse(undefined).success).toBe(false)
  })

  it('parses a complete overview snapshot', () => {
    const parsed = usageOverviewSchema.safeParse(overviewFixture())
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.days).toHaveLength(30)
      expect(parsed.data.weeks).toHaveLength(8)
      expect(Object.keys(parsed.data.dailyByWeek)).toHaveLength(8)
    }
  })

  it('rejects malformed buckets and window shapes', () => {
    const fixture = overviewFixture()
    expect(
      usageOverviewSchema.safeParse({ ...fixture, days: fixture.days.slice(0, 29) }).success
    ).toBe(false)
    expect(
      usageOverviewSchema.safeParse({
        ...fixture,
        weeks: fixture.weeks.map((week, i) => (i === 0 ? { ...week, endAt: week.startAt } : week))
      }).success
    ).toBe(false)
    expect(
      usageOverviewSchema.safeParse({
        ...fixture,
        today: { ...fixture.today, localStartDate: '2026/09/07' }
      }).success
    ).toBe(false)
    expect(
      usageOverviewSchema.safeParse({
        ...fixture,
        dailyByWeek: {
          ...fixture.dailyByWeek,
          'week:0': fixture.dailyByWeek['week:0']!.slice(0, 6)
        }
      }).success
    ).toBe(false)
    expect(usageOverviewSchema.safeParse({ ...fixture, timeZone: '' }).success).toBe(false)
  })

  it('models results as ok or a safe error code', () => {
    expect(
      usageOverviewResultSchema.safeParse({ status: 'ok', overview: overviewFixture() }).success
    ).toBe(true)
    expect(
      usageOverviewResultSchema.safeParse({
        status: 'error',
        error: { code: 'USAGE_READ_FAILED' }
      }).success
    ).toBe(true)
    expect(
      usageOverviewResultSchema.safeParse({ status: 'error', error: { code: 'SQL_INJECTION' } })
        .success
    ).toBe(false)
  })
})
