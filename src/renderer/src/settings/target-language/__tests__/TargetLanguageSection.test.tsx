// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type { PreferencesApi } from '../../../../../shared/preferences'
import { createI18n } from '../../../i18n'
import { TargetLanguageSection } from '../TargetLanguageSection'

function preferencesStub(
  overrides: Partial<{
    getLanguageSettings: PreferencesApi['getLanguageSettings']
    setTargetLanguage: PreferencesApi['setTargetLanguage']
  }> = {}
): { api: PreferencesApi } {
  const api: PreferencesApi = {
    async getLanguageSettings() {
      return (
        overrides.getLanguageSettings?.() ?? {
          status: 'ok',
          settings: { uiLanguage: 'system', resolvedUiLanguage: 'zh-CN', targetLanguage: 'en' }
        }
      )
    },
    async setUiLanguage() {
      throw new Error('unexpected setUiLanguage call')
    },
    async setTargetLanguage(input) {
      if (overrides.setTargetLanguage) return overrides.setTargetLanguage(input)
      return {
        status: 'ok',
        settings: {
          uiLanguage: 'system',
          resolvedUiLanguage: 'zh-CN',
          targetLanguage: input.targetLanguage
        }
      }
    }
  }
  return { api }
}

function renderSection(locale: 'zh-CN' | 'en' = 'zh-CN'): ReturnType<typeof createI18n> {
  const i18n = createI18n(locale)
  render(
    <I18nextProvider i18n={i18n}>
      <TargetLanguageSection />
    </I18nextProvider>
  )
  return i18n
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TargetLanguageSection', () => {
  it('shows the current target language with English only and the support note', async () => {
    const { api } = preferencesStub()
    vi.stubGlobal('api', { preferences: api })
    renderSection()

    expect(screen.getByText('目标学习语言')).toBeInTheDocument()
    const option = screen.getByRole('radio', { name: 'English' })
    expect(option).toBeChecked()
    expect(option).toBeEnabled()
    // 首版说明已国际化；不提供“跟随系统”选项
    expect(screen.getByText('目前仅支持学习英语。')).toBeInTheDocument()
    expect(screen.queryByText(/跟随系统|System/)).not.toBeInTheDocument()
  })

  it('renders the English support note in English chrome', async () => {
    const { api } = preferencesStub()
    vi.stubGlobal('api', { preferences: api })
    renderSection('en')

    expect(screen.getByText('Target language')).toBeInTheDocument()
    expect(screen.getByText('Only English is supported for now.')).toBeInTheDocument()
    await screen.findByRole('radio', { name: 'English' })
  })

  it('does not touch the i18n language when the target language is selected', async () => {
    const { api } = preferencesStub()
    vi.stubGlobal('api', { preferences: api })
    const i18n = renderSection()

    // 唯一可选项已选中：选择动作是幂等的，不触发保存，也不切换界面语言
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    expect(i18n.resolvedLanguage).toBe('zh-CN')
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
    expect(screen.getByRole('radio', { name: 'English' })).toBeEnabled()
  })
})
