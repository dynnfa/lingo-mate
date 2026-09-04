import { z } from 'zod'

export const PREFERENCES_CHANNELS = {
  getLocale: 'preferences:getLocale',
  setLocale: 'preferences:setLocale'
} as const

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const localePreferenceSchema = z.enum(['system', ...SUPPORTED_LOCALES])
export type LocalePreference = z.infer<typeof localePreferenceSchema>

export const localeSettingsSchema = z.object({
  preference: localePreferenceSchema,
  resolvedLocale: z.enum(SUPPORTED_LOCALES)
})
export type LocaleSettings = z.infer<typeof localeSettingsSchema>

export const setLocaleInputSchema = z.object({
  preference: localePreferenceSchema
})
export type SetLocaleInput = z.infer<typeof setLocaleInputSchema>

export const preferencesErrorSchema = z.object({
  code: z.enum(['PREFERENCES_READ_FAILED', 'PREFERENCES_WRITE_FAILED', 'INVALID_LOCALE'])
})
export type PreferencesErrorCode = z.infer<typeof preferencesErrorSchema>['code']

export const getLocaleResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), settings: localeSettingsSchema }),
  z.object({ status: z.literal('error'), error: preferencesErrorSchema })
])
export type GetLocaleResult = z.infer<typeof getLocaleResultSchema>

export const setLocaleResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), settings: localeSettingsSchema }),
  z.object({ status: z.literal('error'), error: preferencesErrorSchema })
])
export type SetLocaleResult = z.infer<typeof setLocaleResultSchema>

export interface PreferencesApi {
  getLocale(): Promise<GetLocaleResult>
  setLocale(input: SetLocaleInput): Promise<SetLocaleResult>
}
