import { createInstance } from 'i18next'
import type { SynonymBatch } from '../shared/synonym'
import type { SupportedLocale } from '../shared/preferences'
import en from '../shared/locales/en/synonym.json'
import zh from '../shared/locales/zh-CN/synonym.json'

export function createSynonymFeedbackFormatter(): (
  report: SynonymBatch,
  language: SupportedLocale
) => string {
  const instance = createInstance()
  void instance.init({
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'synonym',
    resources: { en: { synonym: en }, 'zh-CN': { synonym: zh } },
    interpolation: { escapeValue: false }
  })
  return (report, language) =>
    [
      instance.t('summary', { lng: language }),
      ...report.items.map((item) =>
        instance.t(item.status, {
          lng: language,
          word: item.word,
          ...('entry' in item ? item.entry : {}),
          ...(item.status === 'failed'
            ? { error: instance.t(`errors.${item.code}`, { lng: language }) }
            : {})
        })
      )
    ].join('\n')
}
