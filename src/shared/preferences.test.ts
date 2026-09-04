import { describe, expect, it } from 'vitest'
import {
  getLocaleResultSchema,
  localePreferenceSchema,
  localeSettingsSchema,
  setLocaleInputSchema,
  setLocaleResultSchema
} from './preferences'

describe('preferences protocol schemas', () => {
  it('accepts system and the supported locales as preferences', () => {
    for (const preference of ['system', 'zh-CN', 'en']) {
      expect(localePreferenceSchema.parse(preference)).toBe(preference)
    }
    expect(localePreferenceSchema.safeParse('zh-TW').success).toBe(false)
    expect(localePreferenceSchema.safeParse('en-US').success).toBe(false)
    expect(localePreferenceSchema.safeParse(undefined).success).toBe(false)
  })

  it('requires the resolved locale to be a supported locale', () => {
    expect(localeSettingsSchema.parse({ preference: 'system', resolvedLocale: 'zh-CN' })).toEqual({
      preference: 'system',
      resolvedLocale: 'zh-CN'
    })
    expect(
      localeSettingsSchema.safeParse({ preference: 'system', resolvedLocale: 'en-US' }).success
    ).toBe(false)
  })

  it('validates setLocale input shape', () => {
    expect(setLocaleInputSchema.parse({ preference: 'en' })).toEqual({ preference: 'en' })
    expect(setLocaleInputSchema.safeParse({ preference: 'en', extra: 1 }).success).toBe(true)
    expect(setLocaleInputSchema.safeParse({}).success).toBe(false)
    expect(setLocaleInputSchema.safeParse({ preference: null }).success).toBe(false)
  })

  it('maps ok and error results with a closed error code set', () => {
    expect(
      getLocaleResultSchema.parse({
        status: 'ok',
        settings: { preference: 'en', resolvedLocale: 'en' }
      })
    ).toEqual({ status: 'ok', settings: { preference: 'en', resolvedLocale: 'en' } })

    expect(
      getLocaleResultSchema.parse({ status: 'error', error: { code: 'PREFERENCES_READ_FAILED' } })
    ).toEqual({ status: 'error', error: { code: 'PREFERENCES_READ_FAILED' } })

    for (const schema of [getLocaleResultSchema, setLocaleResultSchema]) {
      expect(schema.safeParse({ status: 'error', error: { code: 'SQLITE_ERROR' } }).success).toBe(
        false
      )
      expect(
        schema.safeParse({
          status: 'error',
          error: { code: 'PREFERENCES_WRITE_FAILED', message: 'x' }
        }).success
      ).toBe(true)
    }
  })
})
