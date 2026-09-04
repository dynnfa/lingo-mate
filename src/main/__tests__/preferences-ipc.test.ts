import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GetLocaleResult, SetLocaleResult } from '../../shared/preferences'
import { PREFERENCES_CHANNELS } from '../../shared/preferences'
import { PreferencesReadError, PreferencesService } from '../preferences'
import { registerPreferencesIpc } from '../preferences-ipc'

const electronMocks = vi.hoisted(() => ({ handle: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle: electronMocks.handle } }))

type IpcHandler = (event: unknown, input: unknown) => unknown

function registeredHandler(channel: string): IpcHandler {
  const registration = electronMocks.handle.mock.calls.find(([candidate]) => candidate === channel)
  if (!registration) throw new Error(`Missing IPC handler: ${channel}`)
  return registration[1] as IpcHandler
}

function serviceWith(read: () => unknown, write: (value: string) => void): PreferencesService {
  return new PreferencesService(
    { readLocalePreference: read, writeLocalePreference: write },
    () => ['en-US']
  )
}

describe('preferences IPC boundary', () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
  })

  it('returns validated locale settings for a well-formed store', async () => {
    registerPreferencesIpc(
      serviceWith(
        () => 'en',
        () => {}
      )
    )

    const result = (await registeredHandler(PREFERENCES_CHANNELS.getLocale)(
      undefined,
      undefined
    )) as GetLocaleResult
    expect(result).toEqual({ status: 'ok', settings: { preference: 'en', resolvedLocale: 'en' } })
  })

  it('maps storage read failures to PREFERENCES_READ_FAILED', async () => {
    registerPreferencesIpc(
      serviceWith(
        () => {
          throw new Error('corrupt file')
        },
        () => {}
      )
    )

    const result = (await registeredHandler(PREFERENCES_CHANNELS.getLocale)(
      undefined,
      undefined
    )) as GetLocaleResult
    expect(result).toEqual({ status: 'error', error: { code: 'PREFERENCES_READ_FAILED' } })
  })

  it('rejects malformed setLocale input with INVALID_LOCALE', async () => {
    registerPreferencesIpc(
      serviceWith(
        () => undefined,
        () => {}
      )
    )

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setLocale)(undefined, {
      preference: 'klingon'
    })) as SetLocaleResult
    expect(result).toEqual({ status: 'error', error: { code: 'INVALID_LOCALE' } })
  })

  it('maps storage write failures to PREFERENCES_WRITE_FAILED', async () => {
    registerPreferencesIpc(
      serviceWith(
        () => undefined,
        () => {
          throw new Error('disk full')
        }
      )
    )

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setLocale)(undefined, {
      preference: 'en'
    })) as SetLocaleResult
    expect(result).toEqual({ status: 'error', error: { code: 'PREFERENCES_WRITE_FAILED' } })
  })

  it('persists a valid preference and returns the resolved settings', async () => {
    const written: string[] = []
    registerPreferencesIpc(
      serviceWith(
        () => undefined,
        (value) => written.push(value)
      )
    )

    const result = (await registeredHandler(PREFERENCES_CHANNELS.setLocale)(undefined, {
      preference: 'system'
    })) as SetLocaleResult
    expect(result).toEqual({
      status: 'ok',
      settings: { preference: 'system', resolvedLocale: 'en' }
    })
    expect(written).toEqual(['system'])
  })

  it('keeps typed service errors out of the payload', async () => {
    const service = new PreferencesService(
      {
        readLocalePreference: () => {
          throw new PreferencesReadError(new Error('secret path /Users/x'))
        },
        writeLocalePreference: () => {}
      },
      () => ['en-US']
    )
    registerPreferencesIpc(service)

    const result = (await registeredHandler(PREFERENCES_CHANNELS.getLocale)(
      undefined,
      undefined
    )) as GetLocaleResult
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('Users')
  })
})
