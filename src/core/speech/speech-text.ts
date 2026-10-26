import { SpeechError } from './speech-synthesizer'

export interface SpeechTextSlice {
  text: string
  charStart: number
}

// Slice, rather than normalize, so the runtime's subtitles reconstruct the original.
export function splitSpeechText(text: string, limit = 350, charStart = 0): SpeechTextSlice[] {
  const parts: SpeechTextSlice[] = []
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(offset + limit, text.length)
    if (end < text.length) {
      const chunk = text.slice(offset, end)
      const boundaries = [...chunk.matchAll(/\s+/gu)]
      const boundary = boundaries.at(-1)
      if (!boundary || boundary.index === 0) throw new SpeechError('TEXT_LIMIT')
      end = offset + boundary.index + boundary[0].length
    }
    parts.push({ text: text.slice(offset, end), charStart: charStart + offset })
    offset = end
  }
  return parts
}
