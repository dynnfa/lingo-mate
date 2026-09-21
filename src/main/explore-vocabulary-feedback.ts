import { createInstance, type i18n as I18nextInstance } from 'i18next'
import type { ExploreVocabularyReport } from '../shared/explore-vocabulary'
import {
  formatExploreVocabularyTable,
  type ExploreVocabularyTableLabels
} from '../core/learning/explore-vocabulary/explore-vocabulary-table'
import exploreEn from '../shared/locales/en/explore-vocabulary.json'
import exploreZhCN from '../shared/locales/zh-CN/explore-vocabulary.json'

// /explore-vocabulary 反馈由 Main 持有的 i18n 资源驱动：本地格式化器把批次
// 条目转为 Markdown 表格，表头语言取报告内的解释语言快照，随 assistant
// 消息持久化后不随界面语言切换变化。
export function createExploreVocabularyFeedbackFormatter(): (
  report: ExploreVocabularyReport
) => string {
  const instance = createInstance()
  void instance.init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN', 'en'],
    defaultNS: 'exploreVocabulary',
    resources: {
      'zh-CN': { exploreVocabulary: exploreZhCN },
      en: { exploreVocabulary: exploreEn }
    },
    interpolation: { escapeValue: false }
  })
  return (report) => {
    const labels = tableLabels(instance, report.explanationLanguage)
    return formatExploreVocabularyTable(report.items, labels)
  }
}

function tableLabels(
  instance: I18nextInstance,
  language: ExploreVocabularyReport['explanationLanguage']
): ExploreVocabularyTableLabels {
  const t = (key: string): string =>
    instance.t(`table.${key}`, { lng: language, ns: 'exploreVocabulary' })
  return { index: t('index'), word: t('word'), meaning: t('meaning'), example: t('example') }
}
