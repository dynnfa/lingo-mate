import { describe, expect, it } from 'vitest'
import { parseVocabularyInput } from '../parse-vocabulary-input'

describe('parseVocabularyInput', () => {
  it('splits only commas, ignores empties and preserves phrases, case and display spelling', () => {
    const items = parseVocabularyInput(
      '  Apple,，apple,,look   up， a;b , cafe\u0301, café, Apple '
    )
    expect(items.map((item) => item.term)).toEqual([
      'Apple',
      'apple',
      'look   up',
      'a;b',
      'cafe\u0301',
      'café',
      'Apple'
    ])
    expect(items[2].lookupKey).toBe('look up')
    expect(items[5]).toMatchObject({ lookupKey: 'café', sourceInputIndex: 4 })
    expect(items[6].sourceInputIndex).toBe(0)
    expect(items[1].sourceInputIndex).toBeUndefined()
  })
  it.each(['', ' , ， ', 'a,'.repeat(21), 'a'.repeat(101), ' '.repeat(4000) + 'a'])(
    'rejects invalid input without truncating',
    (text) => {
      expect(() => parseVocabularyInput(text)).toThrow('INVALID_INPUT')
    }
  )
  it('accepts exact boundaries before deduplication and after normalization', () => {
    expect(parseVocabularyInput(Array(20).fill('apple').join(', '))).toHaveLength(20)
    expect(parseVocabularyInput('a'.repeat(100))[0].lookupKey).toHaveLength(100)
    expect(parseVocabularyInput('a' + ' '.repeat(3999))).toHaveLength(1)
  })
})
