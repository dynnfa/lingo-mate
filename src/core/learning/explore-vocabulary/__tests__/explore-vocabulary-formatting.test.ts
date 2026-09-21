import { describe, expect, it } from 'vitest'
import { formatExploreVocabularyTable } from '../explore-vocabulary-table'

describe('formatExploreVocabularyTable', () => {
  const labels = { index: 'No.', word: 'Word', meaning: 'Meaning', example: 'Example' }
  const items = Array.from({ length: 10 }, (_unused, index) => ({
    term: `word${index}`,
    normalizedTerm: `word${index}`,
    explanation: `meaning ${index}`,
    example: `A sentence with word${index}.`
  }))

  it('renders exactly four columns and ten data rows in item order', () => {
    const table = formatExploreVocabularyTable(items, labels)
    const lines = table.split('\n')
    expect(lines).toHaveLength(12)
    expect(lines[0]).toBe('| No. | Word | Meaning | Example |')
    expect(lines[1]).toBe('| --- | --- | --- | --- |')
    // 句点在单元格内被转义（渲染后仍是普通句点）。
    expect(lines[2]).toBe('| 1 | word0 | meaning 0 | A sentence with word0\\. |')
    expect(lines[11]).toBe('| 10 | word9 | meaning 9 | A sentence with word9\\. |')
  })

  it('renders localized headers', () => {
    const table = formatExploreVocabularyTable(items, {
      index: '序号',
      word: '单词',
      meaning: '释义',
      example: '例句'
    })
    expect(table.split('\n')[0]).toBe('| 序号 | 单词 | 释义 | 例句 |')
  })

  it('escapes cell content so it cannot split columns or inject markup', () => {
    const table = formatExploreVocabularyTable(
      [
        {
          term: 'a | b',
          normalizedTerm: 'a | b',
          explanation: 'pipes \\ backticks ` [link](http://x) <b>bold</b> & amp',
          example: 'Uses a | b with *emphasis* and _underscores_.'
        },
        ...items.slice(1)
      ],
      labels
    )
    const dataRow = table.split('\n')[2]
    // 单元格内容被转义后仍位于同一行；管道符被转义不产生额外列。
    expect(dataRow.split(/\|/u).length).toBeGreaterThan(6)
    expect(dataRow).toContain('\\|')
    expect(dataRow).toContain('\\`')
    expect(dataRow).not.toContain('[link](http://x)')
    expect(dataRow).toContain('\\[link\\](http\\://x)')
    expect(dataRow).toContain('&lt;b&gt;bold&lt;/b&gt;')
    expect(dataRow).toContain('&amp; amp')
  })
})
