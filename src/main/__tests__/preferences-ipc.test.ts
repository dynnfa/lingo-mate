import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GetLanguageSettingsResult,
  SetTargetLanguageResult,
  SetUiLanguageResult
} from '../../shared/preferences'
import { PREFERENCES_CHANNELS } from '../../shared/preferences'
import { PreferencesReadError, PreferencesService, type PreferenceStore } from '../preferences'
import { registerPreferencesIpc } from '../preferences-ipc'

const electronMocks = vi.hoisted(() => ({ handle: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle: electronMocks.handle } }))

type IpcHandler = (event: unknown, input: unknown) => unknown

function registeredHandler(channel: string): IpcHandler {
  const registration = electronMocks.handle.mock.calls.find(([candidate]) => candidate === channel)
  if (!registration) throw new Error(`Missing IPC handler: ${channel}`)
  return registration[1] as IpcHandler
}

function serviceWith(store: PreferenceStore): PreferencesService {
  return new PreferencesService(store, () => ['en-US'])
}

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

describe('preferences IPC boundary', () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
  })

  it('returns validated language settings for a well-formed store', async () => {
    registerPreferencesIpc(serviceWith(memoryStore({ uiLanguage: 'en' })))

    const result = (await registeredHandler(PREFERENCES_CHANNELS.getLanguageSettings)(
      undefined,
      undefined
    )) as GetLanguageSettingsResult
    expect(result).toEqual({
      status: 'ok',
      settings: { uiLanguage: 'en', resolvedUiLanguage: 'en', targetLanguage: 'en' }
    })
  })

  it('maps storage read failures to PREFERENCES_READ_FAILED', async () => {
    const failing: PreferenceStore = {
      ...memoryStore(),
      readUiLanguagePreference: () => {
        throw new Error('corrupt file')
      }
    }
    registerPreferencesIpc(serviceWith(failing))

    const result = (await registeredHandler(PREFERENCES_CHANNELS.getLanguageSettings)(
      undefined,
      undefined
    )) as GetLanguageSettingsResult
    expect(result).toEqual({ status: 'error', error: { code: 'PREFERENCES_READ_FAILED' } })
  })

  it('rejects malformed setUiLanguage input with INVALID_UI_LANGUAGE', async () => {
    registerPreferencesIpc(serviceWith(memoryStore()))

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setUiLanguage)(undefined, {
      uiLanguage: 'klingon'
    })) as SetUiLanguageResult
    expect(result).toEqual({ status: 'error', error: { code: 'INVALID_UI_LANGUAGE' } })
  })

  it('rejects malformed setTargetLanguage input with INVALID_TARGET_LANGUAGE', async () => {
    registerPreferencesIpc(serviceWith(memoryStore()))

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setTargetLanguage)(undefined, {
      targetLanguage: 'fr'
    })) as SetTargetLanguageResult
    expect(result).toEqual({ status: 'error', error: { code: 'INVALID_TARGET_LANGUAGE' } })
  })

  it('maps storage write failures to PREFERENCES_WRITE_FAILED without partial updates', async () => {
    const store = memoryStore({ uiLanguage: 'zh-CN' })
    store.writeUiLanguagePreference = () => {
      throw new Error('disk full')
    }
    registerPreferencesIpc(serviceWith(store))

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setUiLanguage)(undefined, {
      uiLanguage: 'en'
    })) as SetUiLanguageResult
    expect(result).toEqual({ status: 'error', error: { code: 'PREFERENCES_WRITE_FAILED' } })
    expect(store.uiLanguage).toBe('zh-CN')
  })

  it('persists a valid ui language and returns the effective settings', async () => {
    const store = memoryStore({ uiLanguage: 'zh-CN', targetLanguage: 'en' })
    registerPreferencesIpc(serviceWith(store))

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setUiLanguage)(undefined, {
      uiLanguage: 'system'
    })) as SetUiLanguageResult
    expect(result).toEqual({
      status: 'ok',
      settings: { uiLanguage: 'system', resolvedUiLanguage: 'en', targetLanguage: 'en' }
    })
    expect(store.uiLanguage).toBe('system')
    expect(store.targetLanguage).toBe('en')
  })

  it('persists a valid target language without touching the ui language', async () => {
    const store = memoryStore({ uiLanguage: 'zh-CN' })
    registerPreferencesIpc(serviceWith(store))

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setTargetLanguage)(undefined, {
      targetLanguage: 'en'
    })) as SetTargetLanguageResult
    expect(result).toEqual({
      status: 'ok',
      settings: { uiLanguage: 'zh-CN', resolvedUiLanguage: 'zh-CN', targetLanguage: 'en' }
    })
    expect(store.uiLanguage).toBe('zh-CN')
  })

  it('keeps typed service errors out of the payload', async () => {
    const failing: PreferenceStore = {
      ...memoryStore(),
      readUiLanguagePreference: () => {
        throw new PreferencesReadError(new Error('secret path /Users/x'))
      }
    }
    registerPreferencesIpc(serviceWith(failing))

    const result = (await registeredHandler(PREFERENCES_CHANNELS.getLanguageSettings)(
      undefined,
      undefined
    )) as GetLanguageSettingsResult
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('Users')
  })
})
