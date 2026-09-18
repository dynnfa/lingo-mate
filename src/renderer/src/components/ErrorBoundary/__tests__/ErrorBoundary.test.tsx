// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { ErrorBoundary } from '../ErrorBoundary'
import { createI18n } from '../../../i18n'

function Thrower(): React.JSX.Element {
  throw new Error('render exploded')
}

let reportError: ReturnType<typeof vi.fn>

beforeEach(() => {
  reportError = vi.fn().mockResolvedValue({ status: 'ok' })
  vi.stubGlobal('api', { reportError })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ErrorBoundary>
          <p>healthy content</p>
        </ErrorBoundary>
      </I18nextProvider>
    )
    expect(screen.getByText('healthy content')).toBeInTheDocument()
  })

  it('shows the localized fallback and reports the error to main', () => {
    render(
      <I18nextProvider i18n={createI18n('zh-CN')}>
        <ErrorBoundary>
          <Thrower />
        </ErrorBoundary>
      </I18nextProvider>
    )

    expect(screen.getByRole('alert')).toHaveTextContent('页面出现异常')
    expect(screen.getByText('重新加载')).toBeInTheDocument()
    expect(reportError).toHaveBeenCalledTimes(1)
    const report = reportError.mock.calls[0][0] as Record<string, unknown>
    expect(report).toMatchObject({
      source: 'renderer',
      module: 'react',
      operation: 'error-boundary',
      message: 'render exploded'
    })
    expect(String(report['stack'])).toContain('render exploded')
  })
})
