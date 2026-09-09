import { describe, expect, it } from 'vitest'
import { parseSynonymInput, normalizeSynonym } from '../parse-synonym-input'

describe('synonym input', () => {
  it('normalizes English words and preserves original fragments and duplicates', () => {
    const items = parseSynonymInput(' Adequate ，decent,, ADEQUATE ,')
    expect(items.map((item) => item.word)).toEqual(['adequate', 'decent', 'adequate'])
    expect(items[0].input).toBe(' Adequate ')
    expect(items[2].sourceInputIndex).toBe(0)
    expect(normalizeSynonym(' E\u0301  A ')).toBe('é a')
  })
  it.each(['', ' ,， ', 'a'.repeat(101), 'a,'.repeat(21), ' '.repeat(4001)])(
    'rejects invalid input %j',
    (input) => {
      expect(() => parseSynonymInput(input)).toThrow()
    }
  )
  it('accepts the word and batch limits', () => {
    expect(parseSynonymInput('a'.repeat(100))).toHaveLength(1)
    expect(parseSynonymInput(Array(20).fill('word').join(','))).toHaveLength(20)
  })
})
