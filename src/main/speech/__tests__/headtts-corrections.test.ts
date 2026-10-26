import { describe, expect, it } from 'vitest'
import { decoderFrameDurations, repairHeadTtsWav } from '../runtime/headtts-corrections'
import { readSpeechWav } from '../../../core/speech/speech-audio'
import { wav } from '../../../core/speech/__tests__/fixtures/wav'

describe('pinned HeadTTS upstream corrections', () => {
  it('uses the exact ONNX Round(ties-to-even) → Clip(min=1) frame counts, validating waveform length', () => {
    expect(decoderFrameDurations(new Float32Array([0.4, 1.5, 2.5, 3.6]), 9 * 600)).toEqual(
      new Float32Array([1, 2, 2, 4])
    )
    expect(() => decoderFrameDurations(new Float32Array([1.5]), 600)).toThrow()
  })
  it('repairs only the known RIFF byte count, without changing samples or accepting malformed audio', () => {
    const valid = wav()
    const originalPcm = valid.slice(44)
    new DataView(valid.buffer).setUint32(4, valid.byteLength - 12, true)
    const repaired = repairHeadTtsWav(valid.buffer as ArrayBuffer)
    expect(readSpeechWav(repaired).seconds).toBe(1)
    expect(repaired.slice(44)).toEqual(originalPcm)
    new DataView(valid.buffer).setUint32(40, 32, true)
    expect(() => repairHeadTtsWav(valid.buffer as ArrayBuffer)).toThrow()
  })
})
