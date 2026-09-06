import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  LocalePreference,
  PreferencesApi,
  PreferencesErrorCode
} from '../../../shared/preferences'

// 语言名称使用各自的本地语言自称并保持固定，
// 便于用户在陌生界面里找回自己的语言；这些标签不进入翻译资源。
const LANGUAGE_OPTIONS: ReadonlyArray<{ preference: LocalePreference; label: string }> = [
  { preference: 'system', label: '跟随系统 / System' },
  { preference: 'zh-CN', label: '中文' },
  { preference: 'en', label: 'English' }
]

function preferencesFailureMessageKey(
  code: PreferencesErrorCode
): 'errors:preferences.readFailed' | 'errors:preferences.writeFailed' {
  return code === 'PREFERENCES_READ_FAILED'
    ? 'errors:preferences.readFailed'
    : 'errors:preferences.writeFailed'
}

// 设置页“语言”区块：挂载时读取偏好，选择即保存。
// 保存成功后才切换 i18next 语言；失败时保留原语言并提示，保存期间禁止重复提交。
export function LanguagePreferenceSection(): React.JSX.Element {
  const { t, i18n } = useTranslation(['common', 'errors'])
  const [selected, setSelected] = useState<LocalePreference>('system')
  const [saving, setSaving] = useState(false)
  const [failureCode, setFailureCode] = useState<PreferencesErrorCode | undefined>()

  useEffect(() => {
    let cancelled = false
    const preferences: PreferencesApi = window.api.preferences
    void preferences
      .getLocale()
      .then((result) => {
        if (cancelled) return
        if (result.status === 'ok') {
          setSelected(result.settings.preference)
        } else {
          setFailureCode(result.error.code)
        }
      })
      .catch(() => {
        if (!cancelled) setFailureCode('PREFERENCES_READ_FAILED')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selectPreference = (preference: LocalePreference): void => {
    if (saving || preference === selected) {
      return
    }
    setSaving(true)
    setFailureCode(undefined)
    window.api.preferences
      .setLocale({ preference })
      .then(async (result): Promise<void> => {
        if (result.status === 'ok') {
          setSelected(result.settings.preference)
          await i18n.changeLanguage(result.settings.resolvedLocale)
          return
        }
        setFailureCode(result.error.code)
      })
      .catch(() => {
        setFailureCode('PREFERENCES_WRITE_FAILED')
      })
      .finally(() => {
        setSaving(false)
      })
  }

  return (
    <>
      <fieldset className="language-fieldset" disabled={saving}>
        <legend>{t('common:settings.language')}</legend>
        {LANGUAGE_OPTIONS.map((option) => (
          <label className="language-option" key={option.preference}>
            <input
              checked={selected === option.preference}
              name="locale-preference"
              onChange={() => selectPreference(option.preference)}
              type="radio"
              value={option.preference}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      {failureCode ? (
        <p className="settings-error" role="alert">
          {t(preferencesFailureMessageKey(failureCode))}
        </p>
      ) : null}
    </>
  )
}
