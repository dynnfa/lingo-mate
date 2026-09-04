import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  LocalePreference,
  PreferencesApi,
  PreferencesErrorCode
} from '../../../shared/preferences'

// 语言自身名称保持固定（含双语并列的“跟随系统 / System”），
// 便于用户在陌生界面里找回自己的语言；这些标签不进入翻译资源。
const LANGUAGE_OPTIONS: ReadonlyArray<{ preference: LocalePreference; label: string }> = [
  { preference: 'system', label: '跟随系统 / System' },
  { preference: 'zh-CN', label: '简体中文' },
  { preference: 'en', label: 'English' }
]

function preferencesFailureMessageKey(
  code: PreferencesErrorCode
): 'errors:preferences.readFailed' | 'errors:preferences.writeFailed' {
  return code === 'PREFERENCES_READ_FAILED'
    ? 'errors:preferences.readFailed'
    : 'errors:preferences.writeFailed'
}

interface LanguageSettingsProps {
  onClose: () => void
}

// 只包含语言选择的轻量设置面板；由父组件挂载/卸载控制可见性。
// 保存成功后才切换 i18next 语言；失败时保留原语言并提示，保存期间禁止重复提交。
export function LanguageSettings({ onClose }: LanguageSettingsProps): React.JSX.Element {
  const { t, i18n } = useTranslation(['common', 'errors'])
  const [selected, setSelected] = useState<LocalePreference>('system')
  const [saving, setSaving] = useState(false)
  const [failureCode, setFailureCode] = useState<PreferencesErrorCode | undefined>()
  const dialogRef = useRef<HTMLDivElement>(null)

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

  // 打开时把焦点移入面板；关闭后由调用方把焦点还给设置按钮。
  useEffect(() => {
    const firstControl = dialogRef.current?.querySelector<HTMLElement>(
      'input, button, [tabindex]:not([tabindex="-1"])'
    )
    firstControl?.focus()
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

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    if (!focusable || focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="settings-overlay">
      <div
        aria-labelledby="language-settings-title"
        aria-modal="true"
        className="settings-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 id="language-settings-title">{t('common:settings.title')}</h2>
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
        <div className="settings-actions">
          <button onClick={onClose} type="button">
            {t('common:settings.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
