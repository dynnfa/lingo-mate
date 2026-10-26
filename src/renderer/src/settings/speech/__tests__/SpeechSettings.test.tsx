// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '../../../i18n'
import { SpeechSettings } from '../SpeechSettings'
import type { SpeechApi } from '../../../../../shared/speech'

afterEach(cleanup)
describe('speech settings', () => {
  it.each(['en', 'zh-CN'] as const)(
    'loads and saves a bounded configuration in %s',
    async (locale) => {
      const api: SpeechApi = {
        loadConversationAudio: vi.fn(),
        synthesize: vi.fn(),
        cancel: vi.fn(),
        installResources: vi.fn(),
        cancelInstall: vi.fn(),
        onStatus: () => () => {},
        getSettings: async () => ({ status: 'ok', settings: { voice: 'af_bella', speed: 1 } }),
        getRuntimeStatus: async () => ({
          status: 'ok',
          runtime: { phase: 'not-installed', progress: 0 }
        }),
        updateSettings: vi.fn<SpeechApi['updateSettings']>(async (settings) => ({
          status: 'ok',
          settings
        }))
      }
      Object.defineProperty(window, 'api', { configurable: true, value: { speech: api } })
      render(
        <I18nextProvider i18n={createI18n(locale)}>
          <SpeechSettings active />
        </I18nextProvider>
      )
      const voice = await screen.findByRole('combobox', {
        name: locale === 'en' ? 'Voice' : '音色'
      })
      await waitFor(() => expect(voice).toBeEnabled())
      fireEvent.change(voice, { target: { value: 'am_michael' } })
      fireEvent.change(screen.getByRole('slider'), { target: { value: '1.5' } })
      fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Save' : '保存' }))
      await waitFor(() =>
        expect(api.updateSettings).toHaveBeenCalledWith({ voice: 'am_michael', speed: 1.5 })
      )
      expect(
        screen.getByRole('button', {
          name: locale === 'en' ? 'Install speech resources' : '安装语音资源'
        })
      ).toBeVisible()
    }
  )
})
