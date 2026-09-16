import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  PreferencesApi,
  PreferencesErrorCode,
  UiLanguagePreference
} from '../../../../shared/preferences'
import { useIpcRequest } from '../../hooks/useIpcRequest'
import { preferencesFailureMessageKey } from '../../preferences/preferences-failure'

// 语言名称使用各自的本地语言自称并保持固定，
// 便于用户在陌生界面里找回自己的语言；这些标签不进入翻译资源。
const UI_LANGUAGE_OPTIONS: ReadonlyArray<{ preference: UiLanguagePreference; label: string }> = [
  { preference: 'system', label: '跟随系统 / System' },
  { preference: 'zh-CN', label: '中文' },
  { preference: 'en', label: 'English' }
]

// 设置页“界面语言”区块：挂载时读取偏好，选择即保存。
// 保存成功后才切换 i18next 语言；失败时保留原语言并提示，保存期间禁止重复提交。
// 切换界面语言不影响目标学习语言，也不改变会话与输入草稿。
export function UiLanguageSection(): React.JSX.Element {
  const { t, i18n } = useTranslation(['common', 'errors'])
  const [selected, setSelected] = useState<UiLanguagePreference>('system')
  const [failureCode, setFailureCode] = useState<PreferencesErrorCode | undefined>()

  // 挂载读取偏好；卸载或重复挂载的迟到结果由 hook 的 mounted 防护丢弃。
  const readRequest = useIpcRequest(
    async (): Promise<Awaited<ReturnType<PreferencesApi['getLanguageSettings']>>> =>
      window.api.preferences.getLanguageSettings(),
    {
      onComplete: (result) => {
        if (result.status === 'ok') setSelected(result.settings.uiLanguage)
        else setFailureCode(result.error.code)
      },
      onError: () => setFailureCode('PREFERENCES_READ_FAILED')
    }
  )

  const { run: runRead } = readRequest
  useEffect(() => {
    void runRead()
  }, [runRead])

  // 保存成功后才切换界面语言；pending 期间重复选择被静默忽略。
  const saveRequest = useIpcRequest(
    async (
      preference: UiLanguagePreference
    ): Promise<Awaited<ReturnType<PreferencesApi['setUiLanguage']>>> =>
      window.api.preferences.setUiLanguage({ uiLanguage: preference }),
    {
      onComplete: async (result) => {
        if (result.status === 'ok') {
          setSelected(result.settings.uiLanguage)
          await i18n.changeLanguage(result.settings.resolvedUiLanguage)
          return
        }
        setFailureCode(result.error.code)
      },
      onError: () => setFailureCode('PREFERENCES_WRITE_FAILED')
    }
  )

  const selectPreference = (preference: UiLanguagePreference): void => {
    if (saveRequest.pending || preference === selected) {
      return
    }
    setFailureCode(undefined)
    void saveRequest.run(preference)
  }

  return (
    <>
      <fieldset className="language-fieldset" disabled={saveRequest.pending}>
        <legend>{t('common:settings.uiLanguage')}</legend>
        {UI_LANGUAGE_OPTIONS.map((option) => (
          <label className="language-option" key={option.preference}>
            <input
              checked={selected === option.preference}
              name="ui-language-preference"
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
