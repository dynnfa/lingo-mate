import { describe, expect, it } from 'vitest'
import { normalizePhrase, parsePhraseInput, PhraseError } from '../parse-phrase-input'

describe('parsePhraseInput', () => {
  it('splits by lines only and keeps inner spaces, commas, and punctuation', () => {
    const items = parsePhraseInput('look forward to\n\nif anything, at all\n  piece of cake  ')
    expect(items).toEqual([
      { inputIndex: 0, input: 'look forward to', phrase: 'look forward to' },
      { inputIndex: 1, input: 'if anything, at all', phrase: 'if anything, at all' },
      { inputIndex: 2, input: 'piece of cake', phrase: 'piece of cake' }
    ])
  })

  it('accepts CRLF line endings and trims them from the raw input record', () => {
    const items = parsePhraseInput('look forward to\r\npiece of cake\rbreak even')
    expect(items.map((item) => item.phrase)).toEqual([
      'look forward to',
      'piece of cake',
      'break even'
    ])
    expect(items.map((item) => item.input)).toEqual([
      'look forward to',
      'piece of cake',
      'break even'
    ])
  })

  it('normalizes NFC and collapses inner whitespace while staying case-sensitive', () => {
    expect(normalizePhrase('  if\u00A0 \t anything  ')).toBe('if anything')
    const decomposed = 'cafe\u0301 break'
    expect(normalizePhrase(decomposed)).toBe('café break')
    expect(normalizePhrase('Break Even')).not.toBe(normalizePhrase('break even'))
    const items = parsePhraseInput('if  anything\nIF ANYTHING')
    expect(items.map((item) => item.phrase)).toEqual(['if anything', 'IF ANYTHING'])
  })

  it('marks in-batch duplicates after normalization and keeps the original line', () => {
    const items = parsePhraseInput('look  forward to\nlook forward to')
    expect(items[0]).toEqual({
      inputIndex: 0,
      input: 'look  forward to',
      phrase: 'look forward to'
    })
    expect(items[1]).toEqual({
      inputIndex: 1,
      input: 'look forward to',
      phrase: 'look forward to',
      sourceInputIndex: 0
    })
  })

  it('rejects empty input and blank-only lines', () => {
    expect(() => parsePhraseInput('')).toThrow(PhraseError)
    expect(() => parsePhraseInput('  \n\t\n ')).toThrow(PhraseError)
    // 空行被忽略，不以行号占用报告序号
    expect(parsePhraseInput('\n\nok\n')).toHaveLength(1)
  })

  it('rejects over-long batches and phrases', () => {
    expect(() => parsePhraseInput('a'.repeat(4001))).toThrow('INVALID_INPUT')
    expect(() => parsePhraseInput(`${'x'.repeat(201)}`)).toThrow('INVALID_INPUT')
    expect(() =>
      parsePhraseInput(Array.from({ length: 21 }, (_, index) => `phrase ${index}`).join('\n'))
    ).toThrow('INVALID_INPUT')
    // 收敛空白后仍在限内的超长原始行可以通过，规范化文本作为上限判据
    expect(parsePhraseInput(`${'x'.repeat(150)}   ${'y'.repeat(40)}`)[0].phrase).toHaveLength(191)
  })

  it('accepts exactly twenty phrases', () => {
    const items = parsePhraseInput(
      Array.from({ length: 20 }, (_, index) => `phrase ${index}`).join('\n')
    )
    expect(items).toHaveLength(20)
    expect(items[19].inputIndex).toBe(19)
  })
})
