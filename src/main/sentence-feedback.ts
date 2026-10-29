import { createInstance } from 'i18next'
import type { SentenceFeedbackFormatter } from '../core/learning/sentence/sentence-conversation-skill'
import en from '../shared/locales/en/sentence.json'
import zh from '../shared/locales/zh-CN/sentence.json'
export function createSentenceFeedbackFormatter(): SentenceFeedbackFormatter {
  const instance = createInstance()
  void instance.init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    defaultNS: 'sentence',
    resources: { en: { sentence: en }, 'zh-CN': { sentence: zh } },
    interpolation: { escapeValue: false }
  })
  return (report, language) => {
    // Render arbitrary translated text literally in the Markdown conversation view.
    const text = report.entry.translation.replace(/([\\`*_{}[\]()<>#+.!|~:@-])/gu, '\\$1')
    return `${text}\n\n${instance.t(report.status, { lng: language })}`
  }
}
