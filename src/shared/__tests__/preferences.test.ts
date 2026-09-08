import { describe, expect, it } from 'vitest'
import {
  getLanguageSettingsResultSchema,
  languageSettingsSchema,
  setTargetLanguageInputSchema,
  setTargetLanguageResultSchema,
  setUiLanguageInputSchema,
  setUiLanguageResultSchema,
  targetLanguageSchema,
  uiLanguagePreferenceSchema
} from '../preferences'

describe('preferences protocol schemas', () => {
  it('accepts system and the supported locales as ui language preferences', () => {
    for (const preference of ['system', 'zh-CN', 'en']) {
      expect(uiLanguagePreferenceSchema.parse(preference)).toBe(preference)
    }
    expect(uiLanguagePreferenceSchema.safeParse('zh-TW').success).toBe(false)
    expect(uiLanguagePreferenceSchema.safeParse('en-US').success).toBe(false)
    expect(uiLanguagePreferenceSchema.safeParse(undefined).success).toBe(false)
  })

  it('restricts target languages to the supported learning capability', () => {
    expect(targetLanguageSchema.parse('en')).toBe('en')
    expect(targetLanguageSchema.safeParse('ja').success).toBe(false)
    expect(targetLanguageSchema.safeParse('zh-CN').success).toBe(false)
    expect(targetLanguageSchema.safeParse(undefined).success).toBe(false)
  })

  it('requires the resolved ui language to be a supported locale', () => {
    expect(
      languageSettingsSchema.parse({
        uiLanguage: 'system',
        resolvedUiLanguage: 'zh-CN',
        targetLanguage: 'en'
      })
    ).toEqual({ uiLanguage: 'system', resolvedUiLanguage: 'zh-CN', targetLanguage: 'en' })
    expect(
      languageSettingsSchema.safeParse({
        uiLanguage: 'system',
        resolvedUiLanguage: 'en-US',
        targetLanguage: 'en'
      }).success
    ).toBe(false)
  })

  it('validates independent update inputs', () => {
    expect(setUiLanguageInputSchema.parse({ uiLanguage: 'en' })).toEqual({ uiLanguage: 'en' })
    expect(setUiLanguageInputSchema.safeParse({ uiLanguage: 'klingon' }).success).toBe(false)
    expect(setUiLanguageInputSchema.safeParse({}).success).toBe(false)

    expect(setTargetLanguageInputSchema.parse({ targetLanguage: 'en' })).toEqual({
      targetLanguage: 'en'
    })
    expect(setTargetLanguageInputSchema.safeParse({ targetLanguage: 'fr' }).success).toBe(false)
    expect(setTargetLanguageInputSchema.safeParse({}).success).toBe(false)
  })

  it('maps ok and error results with a closed error code set', () => {
    const settings = { uiLanguage: 'en', resolvedUiLanguage: 'en', targetLanguage: 'en' }
    expect(getLanguageSettingsResultSchema.parse({ status: 'ok', settings })).toEqual({
      status: 'ok',
      settings
    })
    expect(setUiLanguageResultSchema.parse({ status: 'ok', settings })).toMatchObject({
      status: 'ok'
    })
    expect(setTargetLanguageResultSchema.parse({ status: 'ok', settings })).toMatchObject({
      status: 'ok'
    })

    for (const schema of [
      getLanguageSettingsResultSchema,
      setUiLanguageResultSchema,
      setTargetLanguageResultSchema
    ]) {
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

    // 非法语言更新使用各自的错误码，不落入通用读写下失败。
    expect(
      setUiLanguageResultSchema.parse({ status: 'error', error: { code: 'INVALID_UI_LANGUAGE' } })
    ).toMatchObject({ status: 'error' })
    expect(
      setTargetLanguageResultSchema.parse({
        status: 'error',
        error: { code: 'INVALID_TARGET_LANGUAGE' }
      })
    ).toMatchObject({ status: 'error' })
  })
})
