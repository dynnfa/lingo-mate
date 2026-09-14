import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  PreferencesApi,
  PreferencesErrorCode,
  TargetLanguage
} from '../../../../shared/preferences'
import { useIpcRequest } from '../../hooks/use-ipc-request'
import { preferencesFailureMessageKey } from '../../preferences/preferences-failure'

// 首版学习能力仅支持英语；语言自称保持固定显示，说明文案进入翻译资源。
const TARGET_LANGUAGE_OPTIONS: ReadonlyArray<{ language: TargetLanguage; label: string }> = [
  { language: 'en', label: 'English' }
]

// 设置页“目标学习语言”区块：练习对话、例句与纠正使用该语言。
// 不提供“跟随系统”，学习目标不随系统语言变化；切换目标语言不影响界面语言。
export function TargetLanguageSection(): React.JSX.Element {
  const { t } = useTranslation(['common', 'errors'])
  const [selected, setSelected] = useState<TargetLanguage>('en')
  const [failureCode, setFailureCode] = useState<PreferencesErrorCode | undefined>()

  // 挂载读取偏好；卸载或重复挂载的迟到结果由 hook 的 mounted 防护丢弃。
  const readRequest = useIpcRequest(
    async (): Promise<Awaited<ReturnType<PreferencesApi['getLanguageSettings']>>> =>
      window.api.preferences.getLanguageSettings(),
    {
      onComplete: (result) => {
        if (result.status === 'ok') setSelected(result.settings.targetLanguage)
        else setFailureCode(result.error.code)
      },
      onError: () => setFailureCode('PREFERENCES_READ_FAILED')
    }
  )

  const { run: runRead } = readRequest
  useEffect(() => {
    void runRead()
  }, [runRead])

  // pending 期间重复选择被静默忽略。
  const saveRequest = useIpcRequest(
    async (
      language: TargetLanguage
    ): Promise<Awaited<ReturnType<PreferencesApi['setTargetLanguage']>>> =>
      window.api.preferences.setTargetLanguage({ targetLanguage: language }),
    {
      onComplete: (result) => {
        if (result.status === 'ok') setSelected(result.settings.targetLanguage)
        else setFailureCode(result.error.code)
      },
      onError: () => setFailureCode('PREFERENCES_WRITE_FAILED')
    }
  )

  const selectLanguage = (language: TargetLanguage): void => {
    if (saveRequest.pending || language === selected) {
      return
    }
    setFailureCode(undefined)
    void saveRequest.run(language)
  }

  return (
    <>
      <fieldset className="language-fieldset" disabled={saveRequest.pending}>
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
