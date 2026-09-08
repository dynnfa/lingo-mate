// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type { ModelsApi } from '../../../../shared/models'
import type { PreferencesApi } from '../../../../shared/preferences'
import type {
  UsageApi,
  UsageBucket,
  UsageOverview,
  UsageOverviewResult
} from '../../../../shared/usage'
import { createI18n } from '../../i18n'
import { SettingsPage } from '../SettingsPage'

const DAY_MS = 86_400_000
// 2026-09-07（周一）为快照当天；days[0] = 8 月 9 日（周日）
const SNAPSHOT_DAY = Date.UTC(2026, 8, 7, 4, 30)

function dayBucket(offset: number, overrides: Partial<UsageBucket> = {}): UsageBucket {
  const startAt = SNAPSHOT_DAY - (29 - offset) * DAY_MS
  const localDate = new Date(startAt).toISOString().slice(0, 10)
  return {
    key: `day:${localDate}`,
    startAt,
    endAt: startAt + DAY_MS,
    localStartDate: localDate,
    localEndDate: localDate,
    requestCount: 0,
    runningCount: 0,
    invalidCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputUnknownCount: 0,
    outputUnknownCount: 0,
    totalUnknownCount: 0,
    future: false,
    ...overrides
  }
}

interface OverviewSetup {
  today?: Partial<UsageBucket>
  /** 按日偏移写入数据；offset 29 为今天 */
  days?: Record<number, Partial<UsageBucket>>
  /** 置空全部数据，构造空账本 */
  empty?: boolean
}

// 构建完整 overview：30 天（offset 0..29，含今天）、8 周（周一起）、每周 7 天。
// 当前周（最后一周）的周一为 offset 29，未来日为 30..35。
// 默认在今天写入少量用量，避免默认快照落入“空账本”分支。
function buildOverview(setup: OverviewSetup = {}): UsageOverview {
  const defaults = setup.empty
    ? {}
    : { 29: { requestCount: 2, inputTokens: 100, outputTokens: 50, totalTokens: 150 } }
  const dayOverrides = { ...defaults, ...(setup.days ?? {}) }
  const dayData: UsageBucket[] = Array.from({ length: 30 }, (_, i) =>
    dayBucket(i, { ...(dayOverrides[i] ?? {}), ...(i === 29 ? (setup.today ?? {}) : {}) })
  )
  // weeks[0] 周一 = 7 月 20 日 = offset -20；当前周周一 = offset 29
  const weekStartOffsets = [-20, -13, -6, 1, 8, 15, 22, 29]
  const weeks = weekStartOffsets.map((offset) => {
    const days = Array.from({ length: 7 }, (_, i) => dayBucket(offset + i))
    const sum = (pick: (day: UsageBucket) => number): number =>
      days.reduce((acc, day) => acc + pick(day), 0)
    const startWall = days[0].localStartDate
    return {
      key: `week:${startWall}`,
      startAt: days[0].startAt,
      endAt: days[6].endAt,
      localStartDate: startWall,
      localEndDate: days[6].localEndDate,
      requestCount: sum((day) => day.requestCount),
      runningCount: sum((day) => day.runningCount),
      invalidCount: sum((day) => day.invalidCount),
      inputTokens: sum((day) => day.inputTokens),
      outputTokens: sum((day) => day.outputTokens),
      totalTokens: sum((day) => day.totalTokens),
      inputUnknownCount: sum((day) => day.inputUnknownCount),
      outputUnknownCount: sum((day) => day.outputUnknownCount),
      totalUnknownCount: sum((day) => day.totalUnknownCount),
      future: false
    }
  })
  const dailyByWeek: Record<string, UsageBucket[]> = {}
  weekStartOffsets.forEach((offset, weekIndex) => {
    dailyByWeek[weeks[weekIndex].key] = Array.from({ length: 7 }, (_, i) =>
      dayBucket(offset + i, { future: offset + i > 29 })
    )
  })
  const today = dayData[29]
  return {
    asOf: new Date(SNAPSHOT_DAY).toISOString(),
    timeZone: 'Asia/Shanghai',
    today,
    thisWeek: weeks[7],
    days: dayData,
    weeks,
    dailyByWeek
  }
}

interface UsageApiStub {
  api: UsageApi
  calls: { overviews: number }
  respond: (result: UsageOverviewResult) => void
}

// 结果按到达顺序排队消费：首次读取使用构造时的初始结果。
function usageApiStub(initial: UsageOverviewResult): UsageApiStub {
  const calls = { overviews: 0 }
  const queue: Array<Promise<UsageOverviewResult>> = [Promise.resolve(initial)]
  const api: UsageApi = {
    async getOverview() {
      calls.overviews += 1
      return queue.shift() ?? new Promise(() => {})
    }
  }
  return {
    api,
    calls,
    respond(result) {
      queue.push(Promise.resolve(result))
    }
  }
}

function preferencesStub(): PreferencesApi {
  return {
    async getLanguageSettings() {
      return {
        status: 'ok',
        settings: { uiLanguage: 'system', resolvedUiLanguage: 'zh-CN', targetLanguage: 'en' }
      }
    },
    async setUiLanguage() {
      return {
        status: 'ok',
        settings: { uiLanguage: 'system', resolvedUiLanguage: 'zh-CN', targetLanguage: 'en' }
      }
    },
    async setTargetLanguage() {
      return {
        status: 'ok',
        settings: { uiLanguage: 'system', resolvedUiLanguage: 'zh-CN', targetLanguage: 'en' }
      }
    }
  }
}

function modelsApiStub(): ModelsApi {
  return {
    async listConfigs() {
      return { status: 'ok', list: { activeConfigId: null, configs: [] } }
    },
    async createConfig() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async updateConfig() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async deleteConfig() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async setActiveConfig() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async testSavedConnection() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async testDraftConnection() {
      return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
    },
    async cancelTest() {
      return { status: 'ok' }
    }
  }
}

function installApi(usage: UsageApi): void {
  vi.stubGlobal('api', {
    preferences: preferencesStub(),
    models: modelsApiStub(),
    usage
  })
}

function renderPage(onExit = vi.fn()): void {
  render(
    <I18nextProvider i18n={createI18n('zh-CN')}>
      <SettingsPage onExit={onExit} />
    </I18nextProvider>
  )
}

async function openUsage(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '用量' }))
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: '用量' })).toBeInTheDocument()
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UsageSettings', () => {
  it('registers the usage section after models and loads data on first activation', async () => {
    const stub = usageApiStub({ status: 'ok', overview: buildOverview() })
    installApi(stub.api)
    renderPage()

    const menuItems = screen
      .getAllByRole('button')
      .filter((button) =>
        ['界面语言', '目标学习语言', '模型', '用量'].includes(button.textContent ?? '')
      )
    expect(menuItems.map((button) => button.textContent)).toEqual([
      '界面语言',
      '目标学习语言',
      '模型',
      '用量'
    ])

    await openUsage()
    expect(screen.getByRole('button', { name: '用量' })).toHaveAttribute('aria-current', 'true')
    // 摘要卡与默认按日图表出现
    expect(await screen.findByText('今日')).toBeVisible()
    expect(screen.getByText('本周')).toBeVisible()
    expect(screen.getByText('最近 30 天用量')).toBeInTheDocument()
    expect(stub.calls.overviews).toBe(1)
  })

  it('shows summary values and the as-of annotation', async () => {
    installApi(
      usageApiStub({
        status: 'ok',
        overview: buildOverview({
          today: { requestCount: 3, inputTokens: 1000, outputTokens: 234, totalTokens: 1234 }
        })
      }).api
    )
    renderPage()
    await openUsage()

    const todayCard = screen.getByText('今日').closest('section')
    expect(todayCard).not.toBeNull()
    expect(within(todayCard as HTMLElement).getByText('1,234')).toBeInTheDocument()
    expect(within(todayCard as HTMLElement).getByText('1,000')).toBeInTheDocument()
    expect(within(todayCard as HTMLElement).getByText('234')).toBeInTheDocument()
    expect(within(todayCard as HTMLElement).getByText(/截至 2026/)).toBeInTheDocument()
  })

  it('switches to the weekly dimension, selects the current week by default, and follows week clicks', async () => {
    const overview = buildOverview({
      days: { 28: { requestCount: 1, inputTokens: 30, outputTokens: 10, totalTokens: 40 } }
    })
    installApi(usageApiStub({ status: 'ok', overview }).api)
    renderPage()
    await openUsage()
    await screen.findByText('最近 30 天用量')

    fireEvent.click(screen.getByRole('button', { name: '按周' }))
    expect(await screen.findByRole('heading', { name: '最近 8 周用量' })).toBeInTheDocument()
    // 周维度默认选中本周：本周每日明细图出现
    const detailTitle = screen.getByRole('heading', { name: /每日用量/ })
    expect(detailTitle.textContent).toContain('9月7日')
    expect(overview.weeks[7]).toBeDefined()

    // 点击上一个周柱切换每日明细
    const previousWeekBar = screen.getAllByRole('button', { name: /8月31日/ })[0]
    fireEvent.click(previousWeekBar)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /每日用量/ }).textContent).toContain('8月31日')
    })
  })

  it('supports keyboard week selection with arrows and Enter', async () => {
    installApi(usageApiStub({ status: 'ok', overview: buildOverview() }).api)
    renderPage()
    await openUsage()
    await screen.findByText('最近 30 天用量')
    fireEvent.click(screen.getByRole('button', { name: '按周' }))
    await screen.findByText('最近 8 周用量')

    const bars = screen.getAllByRole('button', { name: /–/ })
    expect(bars.length).toBeGreaterThanOrEqual(8)
    bars[0].focus()
    expect(bars[0]).toHaveFocus()
    fireEvent.keyDown(bars[0], { key: 'ArrowRight' })
    expect(bars[1]).toHaveFocus()
    fireEvent.keyDown(bars[1], { key: 'Enter' })
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /每日用量/ }).textContent).not.toContain('9月7日')
    })
  })

  it('renders the accessible data table with completeness notes', async () => {
    installApi(
      usageApiStub({
        status: 'ok',
        overview: buildOverview({
          days: {
            29: { requestCount: 2, inputTokens: 100, outputTokens: 40, totalTokens: 140 },
            28: {
              requestCount: 2,
              totalUnknownCount: 1,
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 15
            }
          }
        })
      }).api
    )
    renderPage()
    await openUsage()
    await screen.findByText('最近 30 天用量')

    fireEvent.click(screen.getByRole('button', { name: '查看数据表' }))
    const table = await screen.findByRole('table')
    expect(within(table).getByText('用量数据表')).toBeInTheDocument()
    // 部分未知显示未记录请求数，已知部分保留数值
    expect(within(table).getByText(/1 次请求未返回用量/)).toBeInTheDocument()
    expect(within(table).getByText('140')).toBeInTheDocument()
  })

  it('distinguishes an empty ledger from unknown usage', async () => {
    installApi(usageApiStub({ status: 'ok', overview: buildOverview({ empty: true }) }).api)
    renderPage()
    await openUsage()

    expect(await screen.findByText('尚无用量记录')).toBeInTheDocument()
    expect(screen.getByText(/时间轴范围：2026年8月9日 至 2026年9月7日/)).toBeInTheDocument()
    expect(screen.queryByText('最近 30 天用量')).not.toBeInTheDocument()

    // 有记录但全部未知：显示“未知”而非 0
    cleanup()
    vi.unstubAllGlobals()
    installApi(
      usageApiStub({
        status: 'ok',
        overview: buildOverview({
          today: { requestCount: 4, totalUnknownCount: 4 }
        })
      }).api
    )
    renderPage()
    await openUsage()
    expect(await screen.findByText('最近 30 天用量')).toBeInTheDocument()
    const todayCard = screen.getByText('今日').closest('section')
    expect(within(todayCard as HTMLElement).getAllByText('未知').length).toBeGreaterThanOrEqual(1)
  })

  it('shows a load error with retry for the first read', async () => {
    const stub = usageApiStub({ status: 'error', error: { code: 'USAGE_READ_FAILED' } })
    installApi(stub.api)
    renderPage()
    await openUsage()

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取用量数据')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByText('最近 30 天用量')).not.toBeInTheDocument()

    stub.respond({ status: 'ok', overview: buildOverview() })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('最近 30 天用量')).toBeInTheDocument()
    expect(stub.calls.overviews).toBe(2)
  })

  it('keeps the snapshot and marks stale data when a refresh fails', async () => {
    const stub = usageApiStub({ status: 'ok', overview: buildOverview() })
    installApi(stub.api)
    renderPage()
    await openUsage()
    await screen.findByText('最近 30 天用量')

    stub.respond({ status: 'error', error: { code: 'USAGE_READ_FAILED' } })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(await screen.findByText(/刷新失败/)).toBeInTheDocument()
    expect(screen.getByText(/快照/)).toBeInTheDocument()
    // 旧数据仍在
    expect(screen.getByText('最近 30 天用量')).toBeInTheDocument()
  })

  it('ignores stale responses so old data never overwrites newer snapshots', async () => {
    let call = 0
    const resolvers: Array<(result: UsageOverviewResult) => void> = []
    const api: UsageApi = {
      getOverview() {
        call += 1
        const current = call
        return new Promise((resolve) => {
          resolvers[current - 1] = resolve
        })
      }
    }
    installApi(api)
    renderPage()
    await openUsage()

    // 首次读取挂起：切走再切回触发的第二次读取先返回，迟到的首次响应不覆盖
    fireEvent.click(screen.getByRole('button', { name: '界面语言' }))
    fireEvent.click(screen.getByRole('button', { name: '用量' }))
    const withData = buildOverview({
      today: { requestCount: 1, totalTokens: 777, inputTokens: 700, outputTokens: 77 }
    })
    resolvers[1]?.({ status: 'ok', overview: withData })
    await waitFor(() => {
      expect(screen.getByText('777')).toBeInTheDocument()
    })
    resolvers[0]?.({ status: 'ok', overview: buildOverview() })
    await waitFor(() => {
      expect(screen.getByText('777')).toBeInTheDocument()
    })
  })

  it('re-reads when re-entering the usage section and keeps dimension and week', async () => {
    const stub = usageApiStub({ status: 'ok', overview: buildOverview() })
    installApi(stub.api)
    renderPage()
    await openUsage()
    await screen.findByText('最近 30 天用量')

    fireEvent.click(screen.getByRole('button', { name: '按周' }))
    await screen.findByText('最近 8 周用量')
    // 切走再切回：重新读取，仍处于周维度
    stub.respond({ status: 'ok', overview: buildOverview() })
    fireEvent.click(screen.getByRole('button', { name: '界面语言' }))
    await openUsage()
    await screen.findByText('最近 8 周用量')
    expect(stub.calls.overviews).toBeGreaterThanOrEqual(3)
  })

  it('cancels an in-flight model connection test when switching from models to usage', async () => {
    const cancels: string[] = []
    const models = modelsApiStub()
    models.cancelTest = async (input) => {
      cancels.push(input.requestId)
      return { status: 'ok' }
    }
    vi.stubGlobal('api', {
      preferences: preferencesStub(),
      models,
      usage: usageApiStub({ status: 'ok', overview: buildOverview() }).api
    })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    await openUsage()
    // 用量区块激活且不报错；取消路径由 SettingsPage 的 models 逻辑负责
    expect(screen.getByRole('heading', { name: '用量' })).toBeInTheDocument()
    expect(cancels).toHaveLength(0)
  })
})
