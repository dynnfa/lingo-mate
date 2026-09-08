import { createInstance, type i18n as I18nextInstance } from 'i18next'
import type { SupportedLocale } from '../shared/preferences'
import type { VocabularyBatch } from '../shared/vocabulary'
import type { VocabularyFeedbackFormatter } from '../core/learning/vocabulary/vocabulary-feedback'
import vocabularyEn from '../shared/locales/en/vocabulary.json'
import vocabularyZhCN from '../shared/locales/zh-CN/vocabulary.json'

// 词汇反馈由 Main 持有的 i18n 资源驱动；反馈文本随 assistant 消息持久化，
// 语言取执行时记录的 explanationLanguage，不随界面语言切换变化。
export function createVocabularyFeedbackFormatter(): VocabularyFeedbackFormatter {
  const instance = createInstance()
  void instance.init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN', 'en'],
    defaultNS: 'vocabulary',
    // 资源全部内联，i18next v26 的 init 完成后可立即同步翻译。
    resources: {
      'zh-CN': { vocabulary: vocabularyZhCN },
      en: { vocabulary: vocabularyEn }
    },
    interpolation: { escapeValue: false }
  })
  return (batch, language) => formatVocabularyFeedback(instance, batch, language)
}

function formatVocabularyFeedback(
  instance: I18nextInstance,
  batch: VocabularyBatch,
  language: SupportedLocale
): string {
  const t = (key: string, options: Record<string, unknown> = {}): string =>
    instance.t(key, { ...options, lng: language })
  const details = (['saved', 'existing', 'duplicate', 'failed'] as const)
    .filter((status) => batch.counts[status] > 0)
    .map((status) =>
      t(`feedback.${status}`, {
        count: batch.counts[status],
        terms: new Intl.ListFormat(language).format(
          batch.items.filter((item) => item.status === status).map((item) => item.term)
        )
      })
    )
    .join(t('feedback.separator'))
  const summary = t('feedback.summary', { total: batch.counts.total, details })
  const duplicateSourceFailed = batch.items.some(
    (item) => item.status === 'duplicate' && batch.items[item.sourceInputIndex]?.status === 'failed'
  )
  return duplicateSourceFailed ? `${summary}\n${t('feedback.duplicateSourceFailed')}` : summary
}
