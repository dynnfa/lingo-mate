import type { SpeechWord } from '../../../shared/speech'

export function findSpeechWord(words: readonly SpeechWord[], seconds: number): SpeechWord | null {
  if (!Number.isFinite(seconds)) return null
  let low = 0
  let high = words.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1
    const word = words[mid]
    if (seconds < word.startSeconds) high = mid - 1
    else if (seconds >= word.endSeconds) low = mid + 1
    else return word
  }
  return null
}
