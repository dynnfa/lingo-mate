import { describe, expect, it } from 'vitest'
import {
  ERROR_REPORT_MAX_MESSAGE_LENGTH,
  ERROR_REPORT_MAX_STACK_LENGTH,
  errorReportResultSchema,
  rendererErrorReportSchema
} from '../error-report'

describe('renderer error report schema', () => {
  it('accepts a minimal report and preserves diagnostic fields', () => {
    const parsed = rendererErrorReportSchema.safeParse({
      source: 'renderer',
      module: 'react',
      operation: 'error-boundary',
      code: 'RENDER_FAILED',
      message: 'component crashed',
      stack: 'Error: component crashed\n    at App',
      context: { view: 'conversation' }
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects reports without a source or with an unknown source', () => {
    expect(
      rendererErrorReportSchema.safeParse({ source: 'main', message: 'spoofed' }).success
    ).toBe(false)
    expect(rendererErrorReportSchema.safeParse({ message: 'missing source' }).success).toBe(false)
  })

  it('rejects oversized message and stack values', () => {
    expect(
      rendererErrorReportSchema.safeParse({
        source: 'renderer',
        message: 'x'.repeat(ERROR_REPORT_MAX_MESSAGE_LENGTH + 1)
      }).success
    ).toBe(false)
    expect(
      rendererErrorReportSchema.safeParse({
        source: 'renderer',
        message: 'ok',
        stack: 'x'.repeat(ERROR_REPORT_MAX_STACK_LENGTH + 1)
      }).success
    ).toBe(false)
  })

  it('rejects unexpected fields such as timestamps or file paths', () => {
    const parsed = rendererErrorReportSchema.safeParse({
      source: 'renderer',
      message: 'tries to choose a file',
      timestamp: '2026-09-18T00:00:00Z',
      file: '../../etc/passwd'
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts the ok result and known rejection codes only', () => {
    expect(errorReportResultSchema.safeParse({ status: 'ok' }).success).toBe(true)
    expect(
      errorReportResultSchema.safeParse({ status: 'error', error: { code: 'RATE_LIMITED' } })
        .success
    ).toBe(true)
    expect(
      errorReportResultSchema.safeParse({ status: 'error', error: { code: 'OTHER' } }).success
    ).toBe(false)
  })
})
