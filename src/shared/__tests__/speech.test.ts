import { describe, expect, it } from 'vitest'
import { speechAudioSchema, SPEECH_IDENTITY } from '../speech'

describe('speech result boundary', () => {
  it('rejects a plausible timestamp with an incorrect original-text range', () => {
    const result = {
      requestId: 'a5c2281c-b5de-4f88-809e-04cab8af2c87',
      text: 'hello hello',
      language: 'en',
      settings: { voice: 'af_bella', speed: 1 },
      identity: SPEECH_IDENTITY.revision,
      audio: new Uint8Array(46),
      durationSeconds: 1,
      words: [
        { index: 0, text: 'hello', charStart: 1, charEnd: 6, startSeconds: 0, endSeconds: 0.5 }
      ]
    }
    expect(speechAudioSchema.safeParse(result).success).toBe(false)
  })
})
