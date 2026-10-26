import { SPEECH_LIMITS } from '../../shared/speech'
import { SpeechError } from './speech-synthesizer'

export function readSpeechWav(bytes: Uint8Array): { pcm: Uint8Array; seconds: number } {
  const bad = (): never => {
    throw new SpeechError('INVALID_AUDIO')
  }
  if (bytes.byteLength < 46 || bytes.byteLength > SPEECH_LIMITS.audioBytes) bad()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength)
    bad()
  let format = false
  let pcm: Uint8Array | undefined
  let at = 12
  while (at + 8 <= bytes.byteLength) {
    if (!/^[\x20-\x7e]{4}$/.test(tag(at))) bad()
    const size = view.getUint32(at + 4, true)
    const end = at + 8 + size
    if (end > bytes.byteLength) bad()
    if (tag(at) === 'fmt ') {
      if (
        format ||
        size < 16 ||
        view.getUint16(at + 8, true) !== 1 ||
        view.getUint16(at + 10, true) !== 1 ||
        view.getUint32(at + 12, true) !== 24000 ||
        view.getUint32(at + 16, true) !== 48000 ||
        view.getUint16(at + 20, true) !== 2 ||
        view.getUint16(at + 22, true) !== 16
      )
        bad()
      format = true
    }
    if (tag(at) === 'data') {
      if (pcm || !size || size % 2 !== 0) bad()
      pcm = bytes.subarray(at + 8, end)
    }
    at = end + (size % 2)
  }
  if (!format || !pcm || at !== bytes.length) return bad()
  const seconds = pcm.byteLength / 48000
  if (seconds > SPEECH_LIMITS.seconds) bad()
  return { pcm, seconds }
}

export function joinSpeechPcm(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0)
  if (size > SPEECH_LIMITS.seconds * 48000 || size + 44 > SPEECH_LIMITS.audioBytes)
    throw new SpeechError('INVALID_AUDIO')
  const bytes = new Uint8Array(size + 44)
  const view = new DataView(bytes.buffer)
  const tag = (at: number, value: string): void => {
    ;[...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  }
  tag(0, 'RIFF')
  view.setUint32(4, size + 36, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 24000, true)
  view.setUint32(28, 48000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, size, true)
  let at = 44
  for (const part of parts) {
    bytes.set(part, at)
    at += part.length
  }
  return bytes
}
