// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { PreferencesApi } from '../../../../shared/preferences'
import { loadStartupLocale } from '../startup-locale'

function stubPreferences(api: PreferencesApi): void {
  vi.stubGlobal('api', { preferences: api })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('loadStartupLocale', () => {
  it('uses the resolved locale from main on success', async () => {
    stubPreferences({
      async getLocale() {
        return { status: 'ok', settings: { preference: 'en', resolvedLocale: 'en' } }
      },
      async setLocale() {
        throw new Error('not used')
      }
    })

    expect(await loadStartupLocale()).toEqual({ locale: 'en', failed: false })
  })

  it('falls back to zh-CN and flags a failure when the IPC rejects', async () => {
    stubPreferences({
      getLocale: () => Promise.reject(new Error('ipc unavailable')),
      async setLocale() {
        throw new Error('not used')
      }
    })

    expect(await loadStartupLocale()).toEqual({ locale: 'zh-CN', failed: true })
  })

  it('falls back to zh-CN and flags a failure on a structured error', async () => {
    stubPreferences({
      async getLocale() {
        return { status: 'error', error: { code: 'PREFERENCES_READ_FAILED' } }
      },
      async setLocale() {
        throw new Error('not used')
      }
    })

    expect(await loadStartupLocale()).toEqual({ locale: 'zh-CN', failed: true })
  })

  it('normalizes an unknown locale instead of trusting the wire', async () => {
    stubPreferences({
      async getLocale() {
        // 模拟越界数据：preload 校验被绕过时也不允许未知语言进入 i18next
        return { status: 'ok', settings: { preference: 'en', resolvedLocale: 'fr' } } as never
      },
      async setLocale() {
        throw new Error('not used')
      }
    })

    expect(await loadStartupLocale()).toEqual({ locale: 'zh-CN', failed: false })
  })

  it('stops waiting after the bounded timeout and ignores the late response', async () => {
    stubPreferences({
      getLocale: () => new Promise(() => undefined),
      async setLocale() {
        throw new Error('not used')
      }
    })

    const result = await loadStartupLocale()
    expect(result).toEqual({ locale: 'zh-CN', failed: true })
  }, 4_000)
})
