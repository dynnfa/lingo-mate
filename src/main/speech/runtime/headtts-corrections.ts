import { SpeechError } from '../../../core/speech/speech-synthesizer'
import { readSpeechWav } from '../../../core/speech/speech-audio'

// The pinned timestamped ONNX exports the pre-Round duration tensor. Its decoder
// uses Round(ties-to-even) then Clip(min=1), each frame producing 600 samples.
// Check this equality on every inference; never scale timings to fit the waveform.
export function decoderFrameDurations(raw: Float32Array, sampleCount: number): Float32Array {
  const frames = raw.map((value) => {
    if (!Number.isFinite(value) || value < 0) throw new SpeechError('INVALID_TIMELINE')
    const lower = Math.floor(value)
    const rounded =
      value - lower === 0.5 ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(value)
    return Math.max(1, rounded)
  })
  if (!frames.length || frames.reduce((sum, value) => sum + value, 0) * 600 !== sampleCount)
    throw new SpeechError('INVALID_TIMELINE')
  return frames
}

export function repairHeadTtsWav(audio: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(audio)
  if (bytes.byteLength < 44) throw new SpeechError('INVALID_AUDIO')
  const view = new DataView(audio)
  // HeadTTS 1.3.0 writes 32+PCM bytes where RIFF requires 36+PCM bytes.
  if (view.getUint32(4, true) === bytes.byteLength - 12)
    view.setUint32(4, bytes.byteLength - 8, true)
  readSpeechWav(bytes)
  return bytes
}
