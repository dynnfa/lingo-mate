import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  PreferencesApi,
  PreferencesErrorCode,
  TargetLanguage
} from '../../../shared/preferences'
import { preferencesFailureMessageKey } from './preferences-failure'

// 首版学习能力仅支持英语；语言自称保持固定显示，说明文案进入翻译资源。
const TARGET_LANGUAGE_OPTIONS: ReadonlyArray<{ language: TargetLanguage; label: string }> = [
  { language: 'en', label: 'English' }
]

// 设置页“目标学习语言”区块：练习对话、例句与纠正使用该语言。
// 不提供“跟随系统”，学习目标不随系统语言变化；切换目标语言不影响界面语言。
export function TargetLanguageSection(): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])
  const [selected, setSelected] = useState<TargetLanguage>('en')
  const [saving, setSaving] = useState(false)
  const [failureCode, setFailureCode] = useState<PreferencesErrorCode | undefined>()

  useEffect(() => {
    let cancelled = false
    const preferences: PreferencesApi = window.api.preferences
    void preferences
      .getLanguageSettings()
      .then((result) => {
        if (cancelled) return
        if (result.status === 'ok') {
          setSelected(result.settings.targetLanguage)
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

  const selectLanguage = (language: TargetLanguage): void => {
    if (saving || language === selected) {
      return
    }
    setSaving(true)
    setFailureCode(undefined)
    window.api.preferences
      .setTargetLanguage({ targetLanguage: language })
      .then((result): void => {
        if (result.status === 'ok') {
          setSelected(result.settings.targetLanguage)
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
        <legend>{t('common:settings.targetLanguage')}</legend>
        {TARGET_LANGUAGE_OPTIONS.map((option) => (
          <label className="language-option" key={option.language}>
            <input
              checked={selected === option.language}
              name="target-language"
              onChange={() => selectLanguage(option.language)}
              type="radio"
              value={option.language}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
      <p className="settings-section-description">{t('common:settings.targetLanguageNote')}</p>
      {failureCode ? (
        <p className="settings-error" role="alert">
          {t(preferencesFailureMessageKey(failureCode))}
        </p>
      ) : null}
    </>
  )
}
