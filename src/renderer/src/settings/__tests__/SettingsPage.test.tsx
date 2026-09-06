// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type { PreferencesApi } from '../../../../shared/preferences'
import { createI18n } from '../../i18n'
import { SettingsPage } from '../SettingsPage'

function preferencesStub(): PreferencesApi {
  return {
    async getLocale() {
      return { status: 'ok', settings: { preference: 'system', resolvedLocale: 'zh-CN' } }
    },
    async setLocale() {
      return { status: 'ok', settings: { preference: 'system', resolvedLocale: 'zh-CN' } }
    }
  }
}

function renderPage(onExit = vi.fn()): ReturnType<typeof vi.fn> {
  const i18n = createI18n('zh-CN')
  render(
    <I18nextProvider i18n={i18n}>
      <SettingsPage onExit={onExit} />
    </I18nextProvider>
  )
  return onExit
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SettingsPage', () => {
  it('renders the menu with the language section active and its detail', () => {
    vi.stubGlobal('api', { preferences: preferencesStub() })
    renderPage()

    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument()
    const menuItem = screen.getByRole('button', { name: '语言' })
    expect(menuItem).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('navigation', { name: '设置菜单' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '语言' })).toBeInTheDocument()
    expect(screen.getByText('界面语言')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '跟随系统 / System' })).toBeInTheDocument()
  })

  it('moves focus to the back button when mounted', () => {
    vi.stubGlobal('api', { preferences: preferencesStub() })
    renderPage()

    expect(screen.getByRole('button', { name: '返回' })).toHaveFocus()
  })

  it('calls onExit when the back button is clicked', () => {
    vi.stubGlobal('api', { preferences: preferencesStub() })
    const onExit = renderPage()

    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('calls onExit when Escape is pressed inside the page', () => {
    vi.stubGlobal('api', { preferences: preferencesStub() })
    const onExit = renderPage()

    fireEvent.keyDown(screen.getByRole('main', { name: '设置' }), { key: 'Escape' })

    expect(onExit).toHaveBeenCalledTimes(1)
  })
})
