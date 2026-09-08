import { z } from 'zod'

// 界面语言与目标学习语言是两份独立配置：更新一项不得影响另一项，
// 二者不共享支持列表（界面可跟随系统，学习目标必须显式固定）。
export const PREFERENCES_CHANNELS = {
  getLanguageSettings: 'preferences:getLanguageSettings',
  setUiLanguage: 'preferences:setUiLanguage',
  setTargetLanguage: 'preferences:setTargetLanguage'
} as const

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const uiLanguagePreferenceSchema = z.enum(['system', ...SUPPORTED_LOCALES])
export type UiLanguagePreference = z.infer<typeof uiLanguagePreferenceSchema>

// 首版学习能力仅覆盖英语；新增值必须先完成词汇协议、Prompt 与存储适配。
export const SUPPORTED_TARGET_LANGUAGES = ['en'] as const
export type TargetLanguage = (typeof SUPPORTED_TARGET_LANGUAGES)[number]
export const targetLanguageSchema = z.enum(SUPPORTED_TARGET_LANGUAGES)

export const languageSettingsSchema = z.object({
  uiLanguage: uiLanguagePreferenceSchema,
  // resolvedUiLanguage 由 Main 解析（含跟随系统），不持久化系统解析结果。
  resolvedUiLanguage: z.enum(SUPPORTED_LOCALES),
  targetLanguage: targetLanguageSchema
})
export type LanguageSettings = z.infer<typeof languageSettingsSchema>

export const setUiLanguageInputSchema = z.object({
  uiLanguage: uiLanguagePreferenceSchema
})
export type SetUiLanguageInput = z.infer<typeof setUiLanguageInputSchema>

export const setTargetLanguageInputSchema = z.object({
  targetLanguage: targetLanguageSchema
})
export type SetTargetLanguageInput = z.infer<typeof setTargetLanguageInputSchema>

export const preferencesErrorSchema = z.object({
  code: z.enum([
    'PREFERENCES_READ_FAILED',
    'PREFERENCES_WRITE_FAILED',
    'INVALID_UI_LANGUAGE',
    'INVALID_TARGET_LANGUAGE'
  ])
})
export type PreferencesErrorCode = z.infer<typeof preferencesErrorSchema>['code']

export const getLanguageSettingsResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), settings: languageSettingsSchema }),
  z.object({ status: z.literal('error'), error: preferencesErrorSchema })
])
export type GetLanguageSettingsResult = z.infer<typeof getLanguageSettingsResultSchema>

export const setUiLanguageResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), settings: languageSettingsSchema }),
  z.object({ status: z.literal('error'), error: preferencesErrorSchema })
])
export type SetUiLanguageResult = z.infer<typeof setUiLanguageResultSchema>

export const setTargetLanguageResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), settings: languageSettingsSchema }),
  z.object({ status: z.literal('error'), error: preferencesErrorSchema })
])
export type SetTargetLanguageResult = z.infer<typeof setTargetLanguageResultSchema>

export interface PreferencesApi {
  getLanguageSettings(): Promise<GetLanguageSettingsResult>
  setUiLanguage(input: SetUiLanguageInput): Promise<SetUiLanguageResult>
  setTargetLanguage(input: SetTargetLanguageInput): Promise<SetTargetLanguageResult>
}
