import {
  targetLanguageSchema,
  uiLanguagePreferenceSchema,
  type LanguageSettings,
  type SupportedLocale,
  type TargetLanguage,
  type UiLanguagePreference
} from '../shared/preferences'

// 存储依赖可注入，测试隔离真实用户数据目录。
export interface PreferenceStore {
  readUiLanguagePreference(): unknown
  writeUiLanguagePreference(preference: UiLanguagePreference): void
  readTargetLanguage(): unknown
  writeTargetLanguage(language: TargetLanguage): void
  // 旧版本只保存 localePreference；读取迁移时使用，不再写入。
  readLegacyLocalePreference(): unknown
}

export class PreferencesReadError extends Error {
  constructor(cause: unknown) {
    super('Failed to read language preferences', { cause })
    this.name = 'PreferencesReadError'
  }
}

export class PreferencesWriteError extends Error {
  constructor(cause: unknown) {
    super('Failed to write language preferences', { cause })
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

  getLanguageSettings(): LanguageSettings {
    const uiLanguage = this.readStoredUiLanguage()
    return {
      uiLanguage,
      resolvedUiLanguage: this.resolve(uiLanguage),
      targetLanguage: this.readStoredTargetLanguage()
    }
  }

  setUiLanguage(preference: UiLanguagePreference): LanguageSettings {
    // 先读取另一项设置再写入：读失败时不落盘，避免“已写入却报错”造成
    // 界面与已生效设置不一致；写入成功后返回完整已生效设置。
    const targetLanguage = this.readStoredTargetLanguage()
    try {
      this.store.writeUiLanguagePreference(preference)
    } catch (error) {
      throw new PreferencesWriteError(error)
    }
    return {
      uiLanguage: preference,
      resolvedUiLanguage: this.resolve(preference),
      targetLanguage
    }
  }

  setTargetLanguage(language: TargetLanguage): LanguageSettings {
    const uiLanguage = this.readStoredUiLanguage()
    try {
      this.store.writeTargetLanguage(language)
    } catch (error) {
      throw new PreferencesWriteError(error)
    }
    return {
      uiLanguage,
      resolvedUiLanguage: this.resolve(uiLanguage),
      targetLanguage: language
    }
  }

  private resolve(preference: UiLanguagePreference): SupportedLocale {
    return preference === 'system' ? resolveSystemLocale(this.systemLanguages()) : preference
  }

  // 优先读取合法的新 uiLanguage 字段；没有合法新值时从旧 localePreference
  // 迁移；两者都不可用时采用 system。旧字段保留不删，读取迁移不产生写入，
  // 因此重复启动不会覆盖已保存的新设置，迁移也不会丢失旧偏好。
  private readStoredUiLanguage(): UiLanguagePreference {
    const stored = uiLanguagePreferenceSchema.safeParse(
      this.readStore(() => this.store.readUiLanguagePreference())
    )
    if (stored.success) return stored.data
    const legacy = uiLanguagePreferenceSchema.safeParse(
      this.readStore(() => this.store.readLegacyLocalePreference())
    )
    return legacy.success ? legacy.data : 'system'
  }

  // 存储中缺失或非法的目标语言回退 en；来自 IPC 的非法更新在边界被拒绝，
  // 不进入这里。
  private readStoredTargetLanguage(): TargetLanguage {
    const parsed = targetLanguageSchema.safeParse(
      this.readStore(() => this.store.readTargetLanguage())
    )
    return parsed.success ? parsed.data : 'en'
  }

  private readStore(read: () => unknown): unknown {
    try {
      return read()
    } catch (error) {
      throw new PreferencesReadError(error)
    }
  }
}
