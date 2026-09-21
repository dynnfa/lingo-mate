import type { ExploreVocabularyHistoryItem } from '../../../shared/explore-vocabulary'
import { escapeMarkdownTableCell } from '../explore-table'

// 会话表格的本地格式化器：从已保存的结构化条目生成固定四列 Markdown 表格，
// 不让模型生成表格，也不从 Markdown 反向提取单词。表头由调用方经 i18n
// 注入，首次格式化使用本次执行的解释语言快照，恢复时保持一致。

export interface ExploreVocabularyTableLabels {
  readonly index: string
  readonly word: string
  readonly meaning: string
  readonly example: string
}

export function formatExploreVocabularyTable(
  items: readonly ExploreVocabularyHistoryItem[],
  labels: ExploreVocabularyTableLabels
): string {
  // 表头来自应用 i18n 资源（可信），直接使用；单元格内容来自模型，必须转义。
  const header = `| ${labels.index} | ${labels.word} | ${labels.meaning} | ${labels.example} |`
  const separator = '| --- | --- | --- | --- |'
  const rows = items.map(
    (item, index) =>
      `| ${index + 1} | ${escapeMarkdownTableCell(item.term)} | ${escapeMarkdownTableCell(
        item.explanation
      )} | ${escapeMarkdownTableCell(item.example)} |`
  )
  return [header, separator, ...rows].join('\n')
}
