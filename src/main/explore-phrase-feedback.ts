import { createInstance, type i18n as I18nextInstance } from 'i18next'
import type { ExplorePhraseReport } from '../shared/explore-phrase'
import {
  formatExplorePhraseTable,
  type ExplorePhraseTableLabels
} from '../core/learning/explore-phrase/explore-phrase-table'
import exploreEn from '../shared/locales/en/explore-phrase.json'
import exploreZhCN from '../shared/locales/zh-CN/explore-phrase.json'

// /explore-phrase 反馈由 Main 持有的 i18n 资源驱动：本地格式化器把批次条目
// 转为 Markdown 表格，表头语言取报告内的解释语言快照，随 assistant 消息
// 持久化后不随界面语言切换变化。
export function createExplorePhraseFeedbackFormatter(): (report: ExplorePhraseReport) => string {
  const instance = createInstance()
  void instance.init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN', 'en'],
    defaultNS: 'explorePhrase',
    resources: {
      'zh-CN': { explorePhrase: exploreZhCN },
      en: { explorePhrase: exploreEn }
    },
    interpolation: { escapeValue: false }
  })
  return (report) => {
    const labels = tableLabels(instance, report.explanationLanguage)
    return formatExplorePhraseTable(report.items, labels)
  }
}

function tableLabels(
  instance: I18nextInstance,
  language: ExplorePhraseReport['explanationLanguage']
): ExplorePhraseTableLabels {
  const t = (key: string): string =>
    instance.t(`table.${key}`, { lng: language, ns: 'explorePhrase' })
  return { index: t('index'), phrase: t('phrase'), meaning: t('meaning'), example: t('example') }
}
