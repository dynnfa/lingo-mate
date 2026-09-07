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
  const list = (values: string[]): string =>
    values.length ? new Intl.ListFormat(language).format(values) : t('feedback.emptyList')
  const termsOf = (status: 'saved' | 'existing' | 'failed'): string[] =>
    batch.items.filter((item) => item.status === status).map((item) => item.term)
  const duplicateTerms = batch.items
    .filter((item) => item.status === 'duplicate')
    .map((item) => item.term)

  const summary = t('feedback.summary', {
    total: batch.counts.total,
    saved: batch.counts.saved,
    savedTerms: list(termsOf('saved')),
    existing: batch.counts.existing,
    existingTerms: list(termsOf('existing')),
    duplicate: batch.counts.duplicate,
    duplicateTerms: list(duplicateTerms),
    failed: batch.counts.failed,
    failedTerms: list(termsOf('failed'))
  })
  const duplicateSourceFailed = batch.items.some(
    (item) => item.status === 'duplicate' && batch.items[item.sourceInputIndex]?.status === 'failed'
  )
  return duplicateSourceFailed ? `${summary}\n${t('feedback.duplicateSourceFailed')}` : summary
}
