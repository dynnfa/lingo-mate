import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GetLanguageSettingsResult,
  SetTargetLanguageResult,
  SetUiLanguageResult
} from '../../shared/preferences'
import { PREFERENCES_CHANNELS } from '../../shared/preferences'
import { PreferencesReadError, PreferencesService, type PreferenceStore } from '../preferences'
import { registerPreferencesIpc } from '../preferences-ipc'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import {
  electronMocks,
  FakeSender,
  registeredHandler,
  RENDERER_URL,
  resetIpcMocks
} from './helpers/ipc-test-env'

vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())

const registerTrustedHandler = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })

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
  beforeEach(resetIpcMocks)

  it('returns validated language settings for a well-formed store', async () => {
    registerPreferencesIpc(serviceWith(memoryStore({ uiLanguage: 'en' })), registerTrustedHandler)

    const result = (await registeredHandler(PREFERENCES_CHANNELS.getLanguageSettings)(
      { sender: new FakeSender() },
      undefined
    )) as GetLanguageSettingsResult
    expect(result).toEqual({
      status: 'ok',
      settings: { uiLanguage: 'en', resolvedUiLanguage: 'en', targetLanguage: 'en' }
    })
  })

  it('rejects untrusted sources before touching the service', () => {
    const store = memoryStore()
    registerPreferencesIpc(serviceWith(store), registerTrustedHandler)

    const foreign = new FakeSender()
    foreign.owned = false
    const navigated = new FakeSender()
    navigated.mainFrame = { url: 'https://untrusted.invalid/' }
    const destroyed = new FakeSender()
    destroyed.destroyed = true

    for (const channel of [
      PREFERENCES_CHANNELS.getLanguageSettings,
      PREFERENCES_CHANNELS.setUiLanguage,
      PREFERENCES_CHANNELS.setTargetLanguage
    ]) {
      const handler = registeredHandler(channel)
      for (const event of [
        { sender: foreign },
        { sender: navigated },
        { sender: destroyed },
        { sender: new FakeSender(), senderFrame: null },
        { sender: new FakeSender(), senderFrame: { url: RENDERER_URL } }
      ]) {
        expect(handler(event, { uiLanguage: 'en' })).toEqual({
          status: 'error',
          error: { code: 'UNTRUSTED_SOURCE' }
        })
      }
    }
    expect(store.uiLanguage).toBeUndefined()
    expect(store.targetLanguage).toBeUndefined()
  })

  it('maps storage read failures to PREFERENCES_READ_FAILED', async () => {
    const failing: PreferenceStore = {
      ...memoryStore(),
      readUiLanguagePreference: () => {
        throw new Error('corrupt file')
      }
    }
    registerPreferencesIpc(serviceWith(failing), registerTrustedHandler)

    const result = (await registeredHandler(PREFERENCES_CHANNELS.getLanguageSettings)(
      { sender: new FakeSender() },
      undefined
    )) as GetLanguageSettingsResult
    expect(result).toEqual({ status: 'error', error: { code: 'PREFERENCES_READ_FAILED' } })
  })

  it('rejects malformed setUiLanguage input with INVALID_UI_LANGUAGE', async () => {
    registerPreferencesIpc(serviceWith(memoryStore()), registerTrustedHandler)

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setUiLanguage)(
      { sender: new FakeSender() },
      { uiLanguage: 'klingon' }
    )) as SetUiLanguageResult
    expect(result).toEqual({ status: 'error', error: { code: 'INVALID_UI_LANGUAGE' } })
  })

  it('rejects malformed setTargetLanguage input with INVALID_TARGET_LANGUAGE', async () => {
    registerPreferencesIpc(serviceWith(memoryStore()), registerTrustedHandler)

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setTargetLanguage)(
      { sender: new FakeSender() },
      { targetLanguage: 'fr' }
    )) as SetTargetLanguageResult
    expect(result).toEqual({ status: 'error', error: { code: 'INVALID_TARGET_LANGUAGE' } })
  })

  it('maps storage write failures to PREFERENCES_WRITE_FAILED without partial updates', async () => {
    const store = memoryStore({ uiLanguage: 'zh-CN' })
    store.writeUiLanguagePreference = () => {
      throw new Error('disk full')
    }
    registerPreferencesIpc(serviceWith(store), registerTrustedHandler)

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setUiLanguage)(
      { sender: new FakeSender() },
      { uiLanguage: 'en' }
    )) as SetUiLanguageResult
    expect(result).toEqual({ status: 'error', error: { code: 'PREFERENCES_WRITE_FAILED' } })
    expect(store.uiLanguage).toBe('zh-CN')
  })

  it('persists a valid ui language and returns the effective settings', async () => {
    const store = memoryStore({ uiLanguage: 'zh-CN', targetLanguage: 'en' })
    registerPreferencesIpc(serviceWith(store), registerTrustedHandler)

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setUiLanguage)(
      { sender: new FakeSender() },
      { uiLanguage: 'system' }
    )) as SetUiLanguageResult
    expect(result).toEqual({
      status: 'ok',
      settings: { uiLanguage: 'system', resolvedUiLanguage: 'en', targetLanguage: 'en' }
    })
    expect(store.uiLanguage).toBe('system')
    expect(store.targetLanguage).toBe('en')
  })

  it('persists a valid target language without touching the ui language', async () => {
    const store = memoryStore({ uiLanguage: 'zh-CN' })
    registerPreferencesIpc(serviceWith(store), registerTrustedHandler)

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setTargetLanguage)(
      { sender: new FakeSender() },
      { targetLanguage: 'en' }
    )) as SetTargetLanguageResult
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
    registerPreferencesIpc(serviceWith(failing), registerTrustedHandler)

    const result = (await registeredHandler(PREFERENCES_CHANNELS.getLanguageSettings)(
      { sender: new FakeSender() },
      undefined
    )) as GetLanguageSettingsResult
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('Users')
  })

  it('unregisters all handlers via the returned cleanup', () => {
    const cleanup = registerPreferencesIpc(serviceWith(memoryStore()), registerTrustedHandler)
    expect(electronMocks.handle).toHaveBeenCalledTimes(3)
    expect(electronMocks.removeHandler).not.toHaveBeenCalled()
    cleanup()
    for (const channel of Object.values(PREFERENCES_CHANNELS)) {
      expect(electronMocks.removeHandler).toHaveBeenCalledWith(channel)
    }
  })
})
