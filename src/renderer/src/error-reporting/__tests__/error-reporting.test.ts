// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RendererErrorReport } from '../../../../shared/error-report'
import { reportErrorToMain } from '../reportErrorToMain'
import { installGlobalErrorReporting } from '../installGlobalErrorReporting'

type ReportMock = ReturnType<typeof vi.fn>

let reportError: ReportMock

beforeEach(() => {
  reportError = vi.fn().mockResolvedValue({ status: 'ok' })
  vi.stubGlobal('api', { reportError })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('reportErrorToMain', () => {
  it('forwards the report through window.api', () => {
    reportErrorToMain({ source: 'renderer', message: 'boom' })
    expect(reportError).toHaveBeenCalledWith({ source: 'renderer', message: 'boom' })
  })

  it('swallows ipc rejections instead of throwing', () => {
    reportError.mockRejectedValueOnce(new Error('RATE_LIMITED'))
    expect(() => reportErrorToMain({ source: 'renderer', message: 'boom' })).not.toThrow()
  })

  it('stays silent when window.api is unavailable', () => {
    vi.stubGlobal('api', undefined)
    expect(() => reportErrorToMain({ source: 'renderer', message: 'boom' })).not.toThrow()
  })
})

describe('installGlobalErrorReporting', () => {
  it('reports window errors with stack when available', () => {
    installGlobalErrorReporting()
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('uncaught boom') }))

    expect(reportError).toHaveBeenCalledTimes(1)
    const report = reportError.mock.calls[0][0] as RendererErrorReport
    expect(report).toMatchObject({
      source: 'renderer',
      operation: 'uncaught-error',
      message: 'uncaught boom'
    })
    expect(report.stack).toContain('uncaught boom')
  })

  it('reports unhandled rejections with the rejection reason', () => {
    installGlobalErrorReporting()
    const event = new Event('unhandledrejection') as Event & { reason?: unknown }
    event.reason = new Error('late rejection')
    window.dispatchEvent(event)

    expect(reportError).toHaveBeenCalledTimes(1)
    expect(reportError.mock.calls[0][0]).toMatchObject({
      source: 'renderer',
      operation: 'unhandled-rejection',
      message: 'late rejection'
    })
  })

  it('installs only once', () => {
    installGlobalErrorReporting()
    installGlobalErrorReporting()
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('only once') }))

    expect(reportError).toHaveBeenCalledTimes(1)
  })
})
