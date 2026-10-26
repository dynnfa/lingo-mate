import { describe, expect, it } from 'vitest'
import { findSpeechWord } from '../word-position'

describe('word at the output cursor', () => {
  const words = [
    { index: 0, text: 'hello', charStart: 0, charEnd: 5, startSeconds: 0.2, endSeconds: 0.4 },
    { index: 1, text: 'hello', charStart: 6, charEnd: 11, startSeconds: 0.6, endSeconds: 0.8 }
  ]
  it('uses half-open intervals and returns null for silence, retaining repeated-word identities', () => {
    expect(findSpeechWord(words, 0)).toBeNull()
    expect(findSpeechWord(words, 0.2)?.index).toBe(0)
    expect(findSpeechWord(words, 0.4)).toBeNull()
    expect(findSpeechWord(words, 0.6)?.index).toBe(1)
    expect(findSpeechWord(words, 1)).toBeNull()
  })
  it('does not claim a current word for an invalid output cursor', () => {
    expect(findSpeechWord(words, NaN)).toBeNull()
  })
})
