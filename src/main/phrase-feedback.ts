import { createInstance, type i18n as I18nextInstance } from 'i18next'
import type { SupportedLocale } from '../shared/preferences'
import type { PhraseBatch } from '../shared/phrase'
import type { PhraseFeedbackFormatter } from '../core/learning/phrase/phrase-feedback'
import phraseEn from '../shared/locales/en/phrase.json'
import phraseZhCN from '../shared/locales/zh-CN/phrase.json'

// 短语反馈由 Main 持有的 i18n 资源驱动；反馈文本随 assistant 消息持久化，
// 语言取执行时记录的 explanationLanguage，不随界面语言切换变化。
export function createPhraseFeedbackFormatter(): PhraseFeedbackFormatter {
  const instance = createInstance()
  void instance.init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN', 'en'],
    defaultNS: 'phrase',
    // 资源全部内联，i18next v26 的 init 完成后可立即同步翻译。
    resources: {
      'zh-CN': { phrase: phraseZhCN },
      en: { phrase: phraseEn }
    },
    interpolation: { escapeValue: false }
  })
  return (batch, language) => formatPhraseFeedback(instance, batch, language)
}

function formatPhraseFeedback(
  instance: I18nextInstance,
  batch: PhraseBatch,
  language: SupportedLocale
): string {
  const t = (key: string, options: Record<string, unknown> = {}): string =>
    instance.t(key, { ...options, lng: language })
  const phrases = (filter: (item: PhraseBatch['items'][number]) => boolean): string[] =>
    batch.items.filter(filter).map((item) => item.phrase)
  const unrecognized = batch.items.filter(
    (item) => item.status === 'failed' && item.code === 'UNRECOGNIZED'
  )
  const groups: Array<{ key: string; count: number; terms: string[] }> = [
    {
      key: 'feedback.saved',
      count: batch.counts.saved,
      terms: phrases((item) => item.status === 'saved')
    },
    {
      key: 'feedback.existing',
      count: batch.counts.existing,
      terms: phrases((item) => item.status === 'existing')
    },
    {
      key: 'feedback.duplicate',
      count: batch.counts.duplicate,
      terms: phrases((item) => item.status === 'duplicate')
    },
    {
      key: 'feedback.unrecognized',
      count: unrecognized.length,
      terms: unrecognized.map((item) => item.phrase)
    },
    {
      key: 'feedback.failed',
      count: batch.counts.failed - unrecognized.length,
      terms: phrases((item) => item.status === 'failed' && item.code !== 'UNRECOGNIZED')
    }
  ]
  const listFormat = new Intl.ListFormat(language)
  const details = groups
    .filter((group) => group.count > 0)
    .map((group) => t(group.key, { count: group.count, terms: listFormat.format(group.terms) }))
    .join(t('feedback.separator'))
  const summary = t('feedback.summary', { total: batch.counts.total, details })
  const duplicateSourceFailed = batch.items.some(
    (item) => item.status === 'duplicate' && batch.items[item.sourceInputIndex]?.status === 'failed'
  )
  return duplicateSourceFailed ? `${summary}\n${t('feedback.duplicateSourceFailed')}` : summary
}
