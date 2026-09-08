import { describe, expect, it, vi } from 'vitest'
import {
  matchSupportedLocale,
  PreferencesReadError,
  PreferencesService,
  PreferencesWriteError,
  resolveSystemLocale,
  type PreferenceStore
} from '../preferences'

// 内存存储模拟 electron-store 的键值形态；legacy 字段只读。
function memoryStore(
  initial: Partial<Record<'uiLanguage' | 'targetLanguage' | 'legacyLocale', unknown>> = {}
): PreferenceStore & {
  uiLanguage: unknown
  targetLanguage: unknown
  legacyLocale: unknown
} {
  const state = {
    uiLanguage: initial.uiLanguage,
    targetLanguage: initial.targetLanguage,
    legacyLocale: initial.legacyLocale
  }
  return {
    get uiLanguage() {
      return state.uiLanguage
    },
    get targetLanguage() {
      return state.targetLanguage
    },
    get legacyLocale() {
      return state.legacyLocale
    },
    readUiLanguagePreference: () => state.uiLanguage,
    writeUiLanguagePreference: (preference) => {
      state.uiLanguage = preference
    },
    readTargetLanguage: () => state.targetLanguage,
    writeTargetLanguage: (language) => {
      state.targetLanguage = language
    },
    readLegacyLocalePreference: () => state.legacyLocale
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

describe('PreferencesService language settings', () => {
  it('defaults a fresh install to system ui language and English target', () => {
    const service = new PreferencesService(memoryStore(), () => ['en-US'])
    expect(service.getLanguageSettings()).toEqual({
      uiLanguage: 'system',
      resolvedUiLanguage: 'en',
      targetLanguage: 'en'
    })
  })

  it('migrates a legacy localePreference into the ui language', () => {
    const store = memoryStore({ legacyLocale: 'en' })
    const service = new PreferencesService(store, () => ['zh-Hans-CN'])
    expect(service.getLanguageSettings()).toEqual({
      uiLanguage: 'en',
      resolvedUiLanguage: 'en',
      targetLanguage: 'en'
    })
  })

  it('prefers the stored uiLanguage over the legacy field', () => {
    const store = memoryStore({ uiLanguage: 'zh-CN', legacyLocale: 'en' })
    const service = new PreferencesService(store, () => ['en-US'])
    expect(service.getLanguageSettings().uiLanguage).toBe('zh-CN')
  })

  it('falls back to system when both stored fields are invalid', () => {
    const store = memoryStore({ uiLanguage: 'klingon', legacyLocale: 42 })
    const service = new PreferencesService(store, () => ['zh-Hans-CN'])
    expect(service.getLanguageSettings()).toEqual({
      uiLanguage: 'system',
      resolvedUiLanguage: 'zh-CN',
      targetLanguage: 'en'
    })
  })

  it('falls back to English for a missing or invalid stored target language', () => {
    const missing = new PreferencesService(memoryStore(), () => ['en-US'])
    expect(missing.getLanguageSettings().targetLanguage).toBe('en')

    const invalid = new PreferencesService(memoryStore({ targetLanguage: 'klingon' }), () => [
      'en-US'
    ])
    expect(invalid.getLanguageSettings().targetLanguage).toBe('en')
  })

  it('resolves system by walking the system preference order', () => {
    const service = new PreferencesService(memoryStore({ uiLanguage: 'system' }), () => [
      'zh-Hant-TW',
      'en-GB'
    ])
    expect(service.getLanguageSettings().resolvedUiLanguage).toBe('en')
  })

  it('updates each field independently without overwriting the other', () => {
    const store = memoryStore({ uiLanguage: 'zh-CN', targetLanguage: 'en' })
    const service = new PreferencesService(store, () => ['en-US'])

    expect(service.setUiLanguage('en')).toEqual({
      uiLanguage: 'en',
      resolvedUiLanguage: 'en',
      targetLanguage: 'en'
    })
    expect(store.uiLanguage).toBe('en')
    expect(store.targetLanguage).toBe('en')

    expect(service.setTargetLanguage('en')).toMatchObject({ uiLanguage: 'en' })
    expect(store.uiLanguage).toBe('en')
  })

  it('keeps the legacy field untouched when saving the new ui language', () => {
    const store = memoryStore({ legacyLocale: 'zh-CN' })
    const service = new PreferencesService(store, () => ['en-US'])

    expect(service.setUiLanguage('en')).toMatchObject({ uiLanguage: 'en' })
    expect(store.legacyLocale).toBe('zh-CN')
    expect(store.uiLanguage).toBe('en')
  })

  it('persists only the preference and resolves system lazily', () => {
    const store = memoryStore()
    const systemLanguages = vi.fn(() => ['en-US'])
    const service = new PreferencesService(store, systemLanguages)

    expect(service.setUiLanguage('en')).toMatchObject({
      uiLanguage: 'en',
      resolvedUiLanguage: 'en'
    })
    expect(store.uiLanguage).toBe('en')
    expect(systemLanguages).not.toHaveBeenCalled()

    expect(service.setUiLanguage('system')).toMatchObject({
      uiLanguage: 'system',
      resolvedUiLanguage: 'en'
    })
    expect(store.uiLanguage).toBe('system')
    expect(systemLanguages).toHaveBeenCalledOnce()
  })

  it('does not rewrite stored settings on repeated reads', () => {
    const store = memoryStore({ uiLanguage: 'en', targetLanguage: 'en' })
    const service = new PreferencesService(store, () => ['zh-Hans-CN'])

    const first = service.getLanguageSettings()
    const second = service.getLanguageSettings()

    expect(second).toEqual(first)
    expect(store.uiLanguage).toBe('en')
    expect(store.targetLanguage).toBe('en')
  })

  it('converts storage read failures into a typed error', () => {
    const failing: PreferenceStore = {
      readUiLanguagePreference: () => {
        throw new Error('disk I/O')
      },
      writeUiLanguagePreference: () => {},
      readTargetLanguage: () => undefined,
      writeTargetLanguage: () => {},
      readLegacyLocalePreference: () => undefined
    }
    const service = new PreferencesService(failing, () => ['en-US'])

    expect(() => service.getLanguageSettings()).toThrow(PreferencesReadError)
  })

  it('converts storage write failures into a typed error and keeps stored values', () => {
    const store = memoryStore({ uiLanguage: 'zh-CN' })
    store.writeUiLanguagePreference = () => {
      throw new Error('read-only volume')
    }
    const service = new PreferencesService(store, () => ['en-US'])

    expect(() => service.setUiLanguage('en')).toThrow(PreferencesWriteError)
    expect(store.uiLanguage).toBe('zh-CN')

    const targetStore = memoryStore({ targetLanguage: 'en' })
    targetStore.writeTargetLanguage = () => {
      throw new Error('read-only volume')
    }
    const targetService = new PreferencesService(targetStore, () => ['en-US'])
    expect(() => targetService.setTargetLanguage('en')).toThrow(PreferencesWriteError)
    expect(targetStore.targetLanguage).toBe('en')
  })
})
