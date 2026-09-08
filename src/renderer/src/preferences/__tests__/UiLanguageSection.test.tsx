// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type { PreferencesApi, SetUiLanguageResult } from '../../../../shared/preferences'
import { createI18n } from '../../i18n'
import { UiLanguageSection } from '../UiLanguageSection'

function preferencesStub(
  overrides: Partial<{
    getLanguageSettings: PreferencesApi['getLanguageSettings']
    setUiLanguage: PreferencesApi['setUiLanguage']
  }> = {}
): { api: PreferencesApi; setUiLanguageCalls: unknown[] } {
  const setUiLanguageCalls: unknown[] = []
  const api: PreferencesApi = {
    async getLanguageSettings() {
      return (
        overrides.getLanguageSettings?.() ?? {
          status: 'ok',
          settings: { uiLanguage: 'system', resolvedUiLanguage: 'zh-CN', targetLanguage: 'en' }
        }
      )
    },
    async setUiLanguage(input) {
      setUiLanguageCalls.push(input)
      if (overrides.setUiLanguage) return overrides.setUiLanguage(input)
      const resolvedUiLanguage = input.uiLanguage === 'system' ? 'zh-CN' : input.uiLanguage
      return {
        status: 'ok',
        settings: { uiLanguage: input.uiLanguage, resolvedUiLanguage, targetLanguage: 'en' }
      }
    },
    async setTargetLanguage() {
      throw new Error('unexpected setTargetLanguage call')
    }
  }
  return { api, setUiLanguageCalls }
}

function renderSection(locale: 'zh-CN' | 'en' = 'zh-CN'): ReturnType<typeof createI18n> {
  const i18n = createI18n(locale)
  render(
    <I18nextProvider i18n={i18n}>
      <UiLanguageSection />
    </I18nextProvider>
  )
  return i18n
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UiLanguageSection', () => {
  it('shows fixed language names and the current preference', async () => {
    const { api } = preferencesStub()
    vi.stubGlobal('api', { preferences: api })
    renderSection()

    expect(screen.getByText('界面语言')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '跟随系统 / System' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '中文' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'English' })).not.toBeChecked()
  })

  it('renders English chrome with fixed language names', async () => {
    const { api } = preferencesStub({
      getLanguageSettings: async () => ({
        status: 'ok',
        settings: { uiLanguage: 'en', resolvedUiLanguage: 'en', targetLanguage: 'en' }
      })
    })
    vi.stubGlobal('api', { preferences: api })
    renderSection('en')

    expect(screen.getByText('Display language')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'English' })).toBeChecked()
    })
  })

  it('saves the preference and switches the i18n language to the resolved ui language', async () => {
    const { api, setUiLanguageCalls } = preferencesStub()
    vi.stubGlobal('api', { preferences: api })
    const i18n = renderSection()

    fireEvent.click(screen.getByRole('radio', { name: 'English' }))

    await waitFor(() => {
      expect(setUiLanguageCalls).toEqual([{ uiLanguage: 'en' }])
    })
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked()
    // i18n 实例随 resolvedUiLanguage 切换
    await waitFor(() => {
      expect(i18n.resolvedLanguage).toBe('en')
    })
  })

  it('blocks duplicate submissions while a save is pending', async () => {
    let releaseSave!: (result: SetUiLanguageResult) => void
    const pending = new Promise<SetUiLanguageResult>((resolve) => {
      releaseSave = resolve
    })
    const { api, setUiLanguageCalls } = preferencesStub({
      setUiLanguage: () => pending
    })
    vi.stubGlobal('api', { preferences: api })
    renderSection()

    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    await waitFor(() => expect(setUiLanguageCalls).toHaveLength(1))

    // 保存未完成时选项禁用，重复点击不会再次提交
    expect(screen.getByRole('radio', { name: 'English' })).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: '中文' }))
    expect(setUiLanguageCalls).toHaveLength(1)

    releaseSave({
      status: 'ok',
      settings: { uiLanguage: 'en', resolvedUiLanguage: 'en', targetLanguage: 'en' }
    })
    await waitFor(() => expect(screen.getByRole('radio', { name: 'English' })).toBeEnabled())
    expect(screen.getByRole('radio', { name: 'English' })).toBeChecked()
  })

  it('keeps the previous language and selection when saving fails', async () => {
    const { api } = preferencesStub({
      setUiLanguage: async () => ({ status: 'error', error: { code: 'PREFERENCES_WRITE_FAILED' } })
    })
    vi.stubGlobal('api', { preferences: api })
    const i18n = renderSection()

    fireEvent.click(screen.getByRole('radio', { name: 'English' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('保存语言设置失败，请重试。')
    expect(i18n.resolvedLanguage).toBe('zh-CN')
    expect(screen.getByRole('radio', { name: '跟随系统 / System' })).toBeChecked()
  })

  it('surfaces a read failure without blocking the section', async () => {
    const { api } = preferencesStub({
      getLanguageSettings: async () => ({
        status: 'error',
        error: { code: 'PREFERENCES_READ_FAILED' }
      })
    })
    vi.stubGlobal('api', { preferences: api })
    renderSection()

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取语言设置。')
    expect(screen.getByRole('radio', { name: '跟随系统 / System' })).toBeEnabled()
  })

  it('reports a rejected IPC call as a write failure', async () => {
    const { api } = preferencesStub({
      setUiLanguage: () => Promise.reject(new Error('ipc unavailable'))
    })
    vi.stubGlobal('api', { preferences: api })
    renderSection()

    fireEvent.click(screen.getByRole('radio', { name: 'English' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('保存语言设置失败，请重试。')
  })
})
