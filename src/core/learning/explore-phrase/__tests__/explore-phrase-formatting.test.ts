import { describe, expect, it } from 'vitest'
import {
  explorePhraseExampleContainsPhrase,
  normalizeExplorePhrase
} from '../normalize-explore-phrase'
import { formatExplorePhraseTable } from '../explore-phrase-table'

describe('normalizeExplorePhrase', () => {
  it('applies NFKC, trim, whitespace collapsing and lowercasing', () => {
    expect(normalizeExplorePhrase('  As   a Result ')).toBe('as a result')
    // NFKC：全角字母折叠为半角。
    expect(normalizeExplorePhrase('ＡＢＣ')).toBe('abc')
    expect(normalizeExplorePhrase('on\tthe\nother hand')).toBe('on the other hand')
  })
})

describe('explorePhraseExampleContainsPhrase', () => {
  it('matches with case and whitespace differences', () => {
    expect(explorePhraseExampleContainsPhrase('It rained, AS A RESULT.', 'as a result')).toBe(true)
    expect(explorePhraseExampleContainsPhrase('It rained, as  a result.', 'as a result')).toBe(true)
    expect(explorePhraseExampleContainsPhrase('The match was cancelled.', 'as a result')).toBe(
      false
    )
  })

  it('enforces word boundaries so prefix words do not match', () => {
    expect(
      explorePhraseExampleContainsPhrase('I am looking forward to it.', 'look forward to')
    ).toBe(false)
    expect(explorePhraseExampleContainsPhrase('I look forward to it.', 'look forward to')).toBe(
      true
    )
    expect(explorePhraseExampleContainsPhrase('He was a resultful person.', 'as a result')).toBe(
      false
    )
  })

  it('escapes regex metacharacters in the phrase', () => {
    expect(explorePhraseExampleContainsPhrase('She counted 1+1 (twice).', '1+1 (twice)')).toBe(true)
    expect(explorePhraseExampleContainsPhrase('She counted 111 twice.', '1+1 (twice)')).toBe(false)
  })
})

describe('formatExplorePhraseTable', () => {
  const labels = { index: 'No.', phrase: 'Phrase', meaning: 'Meaning', example: 'Example' }
  const items = Array.from({ length: 10 }, (_unused, index) => ({
    phrase: `phrase ${index}`,
    normalizedPhrase: `phrase ${index}`,
    explanation: `meaning ${index}`,
    example: `A sentence with phrase ${index}.`
  }))

  it('renders exactly four columns and ten data rows in item order', () => {
    const table = formatExplorePhraseTable(items, labels)
    const lines = table.split('\n')
    expect(lines).toHaveLength(12)
    expect(lines[0]).toBe('| No. | Phrase | Meaning | Example |')
    expect(lines[1]).toBe('| --- | --- | --- | --- |')
    // 句点在单元格内被转义（渲染后仍是普通句点）。
    expect(lines[2]).toBe('| 1 | phrase 0 | meaning 0 | A sentence with phrase 0\\. |')
    expect(lines[11]).toBe('| 10 | phrase 9 | meaning 9 | A sentence with phrase 9\\. |')
  })

  it('renders localized headers', () => {
    const table = formatExplorePhraseTable(items, {
      index: '序号',
      phrase: '短语',
      meaning: '释义',
      example: '例句'
    })
    expect(table.split('\n')[0]).toBe('| 序号 | 短语 | 释义 | 例句 |')
  })

  it('escapes every untrusted data column', () => {
    const table = formatExplorePhraseTable(
      [{ ...items[0], phrase: 'a | b', explanation: 'c | d', example: 'e | f' }],
      labels
    )
    expect(table.split('\n')[2]).toBe('| 1 | a \\| b | c \\| d | e \\| f |')
  })
})
