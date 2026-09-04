import { localePreferenceSchema } from '../shared/preferences'
import type { LocalePreference, LocaleSettings, SupportedLocale } from '../shared/preferences'

// 存储依赖可注入，测试隔离真实用户数据目录。
export interface PreferenceStore {
  readLocalePreference(): unknown
  writeLocalePreference(preference: LocalePreference): void
}

export class PreferencesReadError extends Error {
  constructor(cause: unknown) {
    super('Failed to read locale preference', { cause })
    this.name = 'PreferencesReadError'
  }
}

export class PreferencesWriteError extends Error {
  constructor(cause: unknown) {
    super('Failed to write locale preference', { cause })
    this.name = 'PreferencesWriteError'
  }
}

// 以标准语言标签解析器处理大小写、地区和脚本；非法标签直接跳过，
// 不用 startsWith 之类的宽松匹配把繁体变体误判为已支持的简体。
export function matchSupportedLocale(languageTag: string): SupportedLocale | undefined {
  let locale: Intl.Locale
  try {
    locale = new Intl.Locale(languageTag)
  } catch {
    return undefined
  }

  const language = locale.language.toLowerCase()
  if (language === 'en') return 'en'
  if (language !== 'zh') return undefined

  // 繁体中文变体暂不宣称支持：返回 undefined 以继续匹配后续系统偏好。
  if (locale.script === 'Hant') return undefined
  const region = locale.region?.toUpperCase()
  if (region === 'TW' || region === 'HK' || region === 'MO') return undefined
  return 'zh-CN'
}

export function resolveSystemLocale(systemLanguages: readonly string[]): SupportedLocale {
  for (const languageTag of systemLanguages) {
    const matched = matchSupportedLocale(languageTag)
    if (matched) return matched
  }
  return 'zh-CN'
}

export class PreferencesService {
  constructor(
    private readonly store: PreferenceStore,
    private readonly systemLanguages: () => readonly string[]
  ) {}

  getLocale(): LocaleSettings {
    const preference = this.readStoredPreference()
    return { preference, resolvedLocale: this.resolve(preference) }
  }

  setLocale(preference: LocalePreference): LocaleSettings {
    try {
      this.store.writeLocalePreference(preference)
    } catch (error) {
      throw new PreferencesWriteError(error)
    }
    return { preference, resolvedLocale: this.resolve(preference) }
  }

  private resolve(preference: LocalePreference): SupportedLocale {
    return preference === 'system' ? resolveSystemLocale(this.systemLanguages()) : preference
  }

  private readStoredPreference(): LocalePreference {
    let raw: unknown
    try {
      raw = this.store.readLocalePreference()
    } catch (error) {
      throw new PreferencesReadError(error)
    }
    const parsed = localePreferenceSchema.safeParse(raw)
    // 未保存偏好或读到非法字段都等同于 system；只持久化 preference，
    // 不持久化系统解析结果。
    return parsed.success ? parsed.data : 'system'
  }
}
