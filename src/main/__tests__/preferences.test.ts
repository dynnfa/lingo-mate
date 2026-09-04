import { describe, expect, it, vi } from 'vitest'
import {
  matchSupportedLocale,
  PreferencesReadError,
  PreferencesService,
  PreferencesWriteError,
  resolveSystemLocale,
  type PreferenceStore
} from '../preferences'

function memoryStore(initial: unknown = undefined): PreferenceStore & { value: unknown } {
  const holder = { value: initial }
  return {
    get value() {
      return holder.value
    },
    readLocalePreference: () => holder.value,
    writeLocalePreference: (preference) => {
      holder.value = preference
    }
  }
}

describe('system language resolution', () => {
  it('maps supported locales and their regional variants', () => {
    expect(matchSupportedLocale('en')).toBe('en')
    expect(matchSupportedLocale('EN-US')).toBe('en')
    expect(matchSupportedLocale('en-GB')).toBe('en')
    expect(matchSupportedLocale('zh')).toBe('zh-CN')
    expect(matchSupportedLocale('zh-CN')).toBe('zh-CN')
    expect(matchSupportedLocale('zh-SG')).toBe('zh-CN')
    expect(matchSupportedLocale('zh-Hans')).toBe('zh-CN')
    expect(matchSupportedLocale('zh-Hans-CN')).toBe('zh-CN')
  })

  it('does not claim Traditional Chinese variants as supported', () => {
    expect(matchSupportedLocale('zh-TW')).toBeUndefined()
    expect(matchSupportedLocale('zh-HK')).toBeUndefined()
    expect(matchSupportedLocale('zh-MO')).toBeUndefined()
    expect(matchSupportedLocale('zh-Hant')).toBeUndefined()
    expect(matchSupportedLocale('zh-Hant-TW')).toBeUndefined()
  })

  it('skips unsupported and malformed tags', () => {
    expect(matchSupportedLocale('fr-FR')).toBeUndefined()
    expect(matchSupportedLocale('ja')).toBeUndefined()
    expect(matchSupportedLocale('zh_TW')).toBeUndefined()
    expect(matchSupportedLocale('')).toBeUndefined()
    expect(matchSupportedLocale('not a tag')).toBeUndefined()
  })

  it('matches system preferences in order and skips Traditional variants', () => {
    expect(resolveSystemLocale(['zh-Hant-TW', 'en-US'])).toBe('en')
    expect(resolveSystemLocale(['fr-FR', 'zh-Hans-CN'])).toBe('zh-CN')
  })

  it('falls back to zh-CN when nothing matches', () => {
    expect(resolveSystemLocale([])).toBe('zh-CN')
    expect(resolveSystemLocale(['fr-FR', 'ja-JP', 'zh-Hant'])).toBe('zh-CN')
  })
})

describe('PreferencesService', () => {
  it('treats a missing preference as system', () => {
    const service = new PreferencesService(memoryStore(), () => ['en-US'])
    expect(service.getLocale()).toEqual({ preference: 'system', resolvedLocale: 'en' })
  })

  it('treats an invalid stored value as system instead of failing', () => {
    const service = new PreferencesService(memoryStore('klingon'), () => ['zh-Hans-CN'])
    expect(service.getLocale()).toEqual({ preference: 'system', resolvedLocale: 'zh-CN' })
  })

  it('prefers an explicit stored preference over the system language', () => {
    const service = new PreferencesService(memoryStore('zh-CN'), () => ['en-US'])
    expect(service.getLocale()).toEqual({ preference: 'zh-CN', resolvedLocale: 'zh-CN' })
  })

  it('resolves system by walking the system preference order', () => {
    const service = new PreferencesService(memoryStore('system'), () => ['zh-Hant-TW', 'en-GB'])
    expect(service.getLocale()).toEqual({ preference: 'system', resolvedLocale: 'en' })
  })

  it('persists only the preference and returns the resolved settings', () => {
    const store = memoryStore()
    const systemLanguages = vi.fn(() => ['en-US'])
    const service = new PreferencesService(store, systemLanguages)

    expect(service.setLocale('en')).toEqual({ preference: 'en', resolvedLocale: 'en' })
    expect(store.value).toBe('en')
    expect(systemLanguages).not.toHaveBeenCalled()

    expect(service.setLocale('system')).toEqual({ preference: 'system', resolvedLocale: 'en' })
    expect(store.value).toBe('system')
  })

  it('converts storage read failures into a typed error', () => {
    const failing: PreferenceStore = {
      readLocalePreference: () => {
        throw new Error('disk I/O')
      },
      writeLocalePreference: () => {}
    }
    const service = new PreferencesService(failing, () => ['en-US'])

    expect(() => service.getLocale()).toThrow(PreferencesReadError)
  })

  it('converts storage write failures into a typed error', () => {
    const failing: PreferenceStore = {
      readLocalePreference: () => undefined,
      writeLocalePreference: () => {
        throw new Error('read-only volume')
      }
    }
    const service = new PreferencesService(failing, () => ['en-US'])

    expect(() => service.setLocale('en')).toThrow(PreferencesWriteError)
  })
})
