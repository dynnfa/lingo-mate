import { describe, expect, it } from 'vitest'
import { splitSpeechText } from '../speech-text'

describe('speech text slices', () => {
  it('preserves every UTF-16 position across bounded, whole-word slices', () => {
    const text = '  Hello, hello! It’s 2026.\n' + 'word 😀 '.repeat(60)
    const parts = splitSpeechText(text)
    expect(parts.map((part) => part.text).join('')).toBe(text)
    let offset = 0
    for (const part of parts) {
      expect(part.charStart).toBe(offset)
      expect(part.text.length).toBeLessThanOrEqual(350)
      expect(text.slice(part.charStart, part.charStart + part.text.length)).toBe(part.text)
      offset += part.text.length
    }
  })
})
