import type { ExplorePhraseHistoryItem } from '../../../shared/explore-phrase'
import { EXPLORE_PHRASE_ITEM_COUNT } from '../../../shared/explore-phrase'

// 会话表格的本地格式化器：从已保存的结构化条目生成固定四列 Markdown 表格，
// 不让模型生成表格，也不从 Markdown 反向提取短语。表头由调用方经 i18n 注入，
// 首次格式化使用本次执行的解释语言快照，恢复时保持一致。

export interface ExplorePhraseTableLabels {
  readonly index: string
  readonly phrase: string
  readonly meaning: string
  readonly example: string
}

// 单元格按纯文本处理：先转义反斜杠与 Markdown 标记（管道符、反引号、强调、
// 链接/图片方括号、删除线），再转义 HTML 字符，防止内容拆列、插入链接、
// 图片或 HTML。句点、冒号与 @ 也一并转义：渲染结果不变，但破坏 GFM 对
// 裸 URL、www 前缀与邮箱的自动链接匹配。条目已由 schema 限定单行，
// 不通过换行破坏表格。
export function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/([\\|`*_[\]~.:@])/gu, '\\$1')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}

export function formatExplorePhraseTable(
  items: readonly ExplorePhraseHistoryItem[],
  labels: ExplorePhraseTableLabels
): string {
  // 表头来自应用 i18n 资源（可信），直接使用；单元格内容来自模型，必须转义。
  const header = `| ${labels.index} | ${labels.phrase} | ${labels.meaning} | ${labels.example} |`
  const separator = '| --- | --- | --- | --- |'
  const rows = items
    .slice(0, EXPLORE_PHRASE_ITEM_COUNT)
    .map(
      (item, index) =>
        `| ${index + 1} | ${escapeMarkdownTableCell(item.phrase)} | ${escapeMarkdownTableCell(
          item.explanation
        )} | ${escapeMarkdownTableCell(item.example)} |`
    )
  return [header, separator, ...rows].join('\n')
}
