import type { SpeechWord } from '../../shared/speech'
import { SpeechError, type HeadTtsTiming } from './speech-synthesizer'

export function buildSpeechTimeline(
  text: string,
  timing: HeadTtsTiming,
  duration: number
): SpeechWord[] {
  const { words, wtimes, wdurations } = timing
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    words.length !== wtimes.length ||
    words.length !== wdurations.length ||
    words.join('') !== text
  ) {
    throw new SpeechError('INVALID_TIMELINE')
  }
  const tolerance = 0.001 + 1 / 24000
  const result: SpeechWord[] = []
  let charOffset = 0
  let previousEnd = 0
  for (let i = 0; i < words.length; i++) {
    const subtitle = words[i]
    const first = subtitle.search(/[\p{L}\p{N}]/u)
    const end = subtitle.search(/[^\p{L}\p{N}]*$/u)
    const base = charOffset
    charOffset += subtitle.length
    if (first < 0) continue
    let startSeconds = wtimes[i] / 1000
    let endSeconds = (wtimes[i] + wdurations[i]) / 1000
    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      wdurations[i] <= 0 ||
      startSeconds < -tolerance ||
      startSeconds < previousEnd - tolerance ||
      endSeconds > duration + tolerance ||
      endSeconds <= startSeconds
    ) {
      throw new SpeechError('INVALID_TIMELINE')
    }
    startSeconds = Math.max(0, previousEnd, startSeconds)
    endSeconds = Math.min(duration, endSeconds)
    if (endSeconds <= startSeconds) throw new SpeechError('INVALID_TIMELINE')
    result.push({
      index: result.length,
      text: subtitle.slice(first, end),
      charStart: base + first,
      charEnd: base + end,
      startSeconds,
      endSeconds
    })
    previousEnd = endSeconds
  }
  if (!result.length) throw new SpeechError('INVALID_TIMELINE')
  return result
}
