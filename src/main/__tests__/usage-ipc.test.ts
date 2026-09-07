import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmUsageStatisticsError } from '../../core/llm/llm-usage-statistics'
import { USAGE_CHANNELS, type UsageOverview } from '../../shared/usage'
import { registerUsageIpc, toSafeUsageError } from '../usage-ipc'

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  fromWebContents: vi.fn((sender: { owned: boolean }) =>
    sender.owned ? { webContents: sender } : null
  )
}))

vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle, removeHandler: electronMocks.removeHandler },
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents }
}))

const RENDERER_URL = 'file:///app/renderer/index.html'

class FakeSender extends EventEmitter {
  readonly id = 7
  owned = true
  destroyed = false
  mainFrame = { url: RENDERER_URL }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

type IpcHandler = (
  event: { sender: FakeSender; senderFrame?: { url: string } | null },
  input: unknown
) => unknown

function registeredHandler(): IpcHandler {
  const registration = electronMocks.handle.mock.calls.find(
    ([channel]) => channel === USAGE_CHANNELS.getOverview
  )
  if (!registration) throw new Error('Missing IPC handler for usage:getOverview')
  const handler = registration[1] as IpcHandler
  return (event, input) => handler({ senderFrame: event.sender.mainFrame, ...event }, input)
}

function emptyBucket(dayIndex: number): {
  key: string
  startAt: number
  endAt: number
  localStartDate: string
  localEndDate: string
  requestCount: number
  runningCount: number
  invalidCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  inputUnknownCount: number
  outputUnknownCount: number
  totalUnknownCount: number
  future: boolean
} {
  const startAt = dayIndex * 86_400_000
  return {
    key: `day:${dayIndex}`,
    startAt,
    endAt: startAt + 86_400_000,
    localStartDate: '2026-09-07',
    localEndDate: '2026-09-07',
    requestCount: 0,
    runningCount: 0,
    invalidCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputUnknownCount: 0,
    outputUnknownCount: 0,
    totalUnknownCount: 0,
    future: false
  }
}

function overviewFixture(): UsageOverview {
  const days = Array.from({ length: 30 }, (_, i) => emptyBucket(i))
  const weeks = Array.from({ length: 8 }, (_, i) => ({ ...emptyBucket(i), key: `week:${i}` }))
  const dailyByWeek: Record<string, UsageOverview['days']> = {}
  for (const week of weeks) {
    dailyByWeek[week.key] = Array.from({ length: 7 }, (_, i) => emptyBucket(i))
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

function fakeService(overrides: Partial<{ getOverview: () => UsageOverview }> = {}): {
  getOverview: ReturnType<typeof vi.fn>
} {
  return { getOverview: vi.fn(overrides.getOverview ?? overviewFixture) }
}

beforeEach(() => {
  electronMocks.handle.mockReset()
  electronMocks.removeHandler.mockReset()
})

describe('usage IPC', () => {
  it('rejects untrusted callers before touching the service', () => {
    const service = fakeService()
    registerUsageIpc(service as never, RENDERER_URL)
    const handler = registeredHandler()

    const foreign = new FakeSender()
    foreign.owned = false
    const navigated = new FakeSender()
    navigated.mainFrame = { url: 'https://untrusted.invalid/' }
    const destroyed = new FakeSender()
    destroyed.destroyed = true
    const subFrame = new FakeSender()
    ;(subFrame as unknown as { mainFrame: { url: string; notMain: true } }).mainFrame = {
      url: RENDERER_URL,
      notMain: true
    }

    for (const sender of [foreign, navigated, destroyed]) {
      expect(handler({ sender }, {})).toEqual({
        status: 'error',
        error: { code: 'UNTRUSTED_SOURCE' }
      })
    }
    const subFrameResult = handler({ sender: subFrame, senderFrame: { url: RENDERER_URL } }, {})
    expect(subFrameResult).toEqual({ status: 'error', error: { code: 'UNTRUSTED_SOURCE' } })
    expect(service.getOverview).not.toHaveBeenCalled()
  })

  it('rejects inputs outside the predefined window', () => {
    const service = fakeService()
    registerUsageIpc(service as never, RENDERER_URL)
    const handler = registeredHandler()

    expect(handler({ sender: new FakeSender() }, { days: 7 })).toEqual({
      status: 'error',
      error: { code: 'INVALID_INPUT' }
    })
    expect(service.getOverview).not.toHaveBeenCalled()
  })

  it('returns the parsed overview for trusted callers', () => {
    const overview = overviewFixture()
    const service = fakeService({ getOverview: () => overview })
    registerUsageIpc(service as never, RENDERER_URL)

    expect(registeredHandler()({ sender: new FakeSender() }, {})).toEqual({
      status: 'ok',
      overview
    })
  })

  it('maps core errors to safe codes without internals', () => {
    const service = fakeService()
    service.getOverview.mockImplementation(() => {
      throw new LlmUsageStatisticsError('OVERFLOW')
    })
    registerUsageIpc(service as never, RENDERER_URL)
    expect(registeredHandler()({ sender: new FakeSender() }, {})).toEqual({
      status: 'error',
      error: { code: 'USAGE_OVERFLOW' }
    })

    service.getOverview.mockImplementation(() => {
      throw new LlmUsageStatisticsError('READ_FAILED')
    })
    expect(registeredHandler()({ sender: new FakeSender() }, {})).toEqual({
      status: 'error',
      error: { code: 'USAGE_READ_FAILED' }
    })

    service.getOverview.mockImplementation(() => {
      throw new Error('sqlite file locked at /Users/x/secret.sqlite')
    })
    const unknown = registeredHandler()({ sender: new FakeSender() }, {})
    expect(unknown).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
    expect(JSON.stringify(unknown)).not.toContain('sqlite')
  })

  it('reports a safe error when the aggregate violates the protocol', () => {
    const service = fakeService()
    service.getOverview.mockReturnValue({ days: [] } as unknown as UsageOverview)
    registerUsageIpc(service as never, RENDERER_URL)
    expect(registeredHandler()({ sender: new FakeSender() }, {})).toEqual({
      status: 'error',
      error: { code: 'UNKNOWN_ERROR' }
    })
  })

  it('unregisters the handler via the returned cleanup', () => {
    const cleanup = registerUsageIpc(fakeService() as never, RENDERER_URL)
    expect(electronMocks.handle).toHaveBeenCalledTimes(1)
    expect(electronMocks.removeHandler).not.toHaveBeenCalled()
    cleanup()
    expect(electronMocks.removeHandler).toHaveBeenCalledWith(USAGE_CHANNELS.getOverview)
  })

  it('maps statistics error codes exhaustively', () => {
    expect(toSafeUsageError(new LlmUsageStatisticsError('OVERFLOW'))).toEqual({
      code: 'USAGE_OVERFLOW'
    })
    expect(toSafeUsageError(new LlmUsageStatisticsError('READ_FAILED'))).toEqual({
      code: 'USAGE_READ_FAILED'
    })
    expect(toSafeUsageError(new Error('boom'))).toEqual({ code: 'UNKNOWN_ERROR' })
    expect(toSafeUsageError('str')).toEqual({ code: 'UNKNOWN_ERROR' })
  })
})
