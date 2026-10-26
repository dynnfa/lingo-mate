import { describe, expect, it } from 'vitest'
import { SpeechService } from '../speech-service'
import type { SpeechSynthesizer } from '../speech-synthesizer'
import { SpeechError } from '../speech-synthesizer'
import { DEFAULT_SPEECH_SETTINGS } from '../../../shared/speech'
import { readSpeechWav } from '../speech-audio'

import { wav } from './fixtures/wav'

const requestId = 'a5c2281c-b5de-4f88-809e-04cab8af2c87'
describe('speech synthesis', () => {
  it('synthesizes and joins 360 seconds of audio with word timestamps beyond 120 seconds', async () => {
    const text = 'Hello. '.repeat(200)
    const service = new SpeechService({
      async synthesize(part) {
        const words = part.match(/Hello\. /g)!
        return {
          audio: wav(90),
          words,
          wtimes: words.map((_, i) => i * 1000),
          wdurations: words.map(() => 500)
        }
      }
    })
    const audio = await service.synthesize(
      { requestId, text, language: 'en' },
      DEFAULT_SPEECH_SETTINGS,
      new AbortController().signal
    )
    expect(audio.durationSeconds).toBe(360)
    expect(audio.audio.byteLength).toBe(44 + 360 * 48000)
    expect(readSpeechWav(audio.audio).seconds).toBe(360)
    expect(audio.words).toHaveLength(200)
    expect(audio.words.at(-1)).toMatchObject({
      charStart: 1393,
      charEnd: 1398,
      startSeconds: 319,
      endSeconds: 319.5
    })
  })

  it('rejects cumulative audio exceeding 360 seconds', async () => {
    const service = new SpeechService({
      async synthesize(part) {
        return { audio: wav(90.25), words: [part], wtimes: [0], wdurations: [500] }
      }
    })
    await expect(
      service.synthesize(
        { requestId, text: 'Hello. '.repeat(200), language: 'en' },
        DEFAULT_SPEECH_SETTINGS,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'INVALID_AUDIO' })
  })

  it('adds actual preceding audio duration to subsequent words, retaining all tail silence', async () => {
    const text = 'Hello. '.repeat(60)
    const synthesizer: SpeechSynthesizer = {
      async synthesize(part) {
        const words = part.match(/Hello\. /g)!
        return {
          audio: wav(),
          words,
          wtimes: words.map((_, i) => i * 10),
          wdurations: words.map(() => 10)
        }
      }
    }
    const audio = await new SpeechService(synthesizer).synthesize(
      { requestId, text, language: 'en' },
      DEFAULT_SPEECH_SETTINGS,
      new AbortController().signal
    )
    expect(audio.durationSeconds).toBe(2)
    expect(audio.words[50].startSeconds).toBe(1)
    expect(audio.words[50].charStart).toBe(350)
    expect(audio.audio.byteLength).toBe(44 + 2 * 48000)
  })
  it('synthesizes 4,000 UTF-16 units without losing text or word positions', async () => {
    const text = 'word '.repeat(800)
    const parts: string[] = []
    const service = new SpeechService({
      async synthesize(part) {
        parts.push(part)
        const words = part.match(/word /g)!
        return {
          audio: wav(),
          words,
          wtimes: words.map((_, i) => i * 10),
          wdurations: words.map(() => 10)
        }
      }
    })
    const audio = await service.synthesize(
      { requestId, text, language: 'en' },
      DEFAULT_SPEECH_SETTINGS,
      new AbortController().signal
    )
    expect(parts.join('')).toBe(text)
    expect(audio.text).toBe(text)
    expect(audio.words).toHaveLength(800)
    expect(audio.words.at(-1)).toMatchObject({
      text: 'word',
      charStart: 3995,
      charEnd: 3999
    })
  })
  it('rejects more than 4,000 UTF-16 units before invoking inference', async () => {
    let called = false
    const service = new SpeechService({
      async synthesize() {
        called = true
        throw new Error('unused')
      }
    })
    await expect(
      service.synthesize(
        { requestId, text: 'a'.repeat(4001), language: 'en' },
        DEFAULT_SPEECH_SETTINGS,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(called).toBe(false)
  })
  it('subdivides a token-budget preflight rejection without truncating or losing text', async () => {
    const accepted: string[] = []
    const service = new SpeechService({
      async synthesize(text) {
        if (text.length > 10) throw new SpeechError('TOKEN_LIMIT')
        accepted.push(text)
        return { audio: wav(), words: [text], wtimes: [0], wdurations: [500] }
      }
    })
    const text = 'Hello hello hello hello '
    const audio = await service.synthesize(
      { requestId, text, language: 'en' },
      DEFAULT_SPEECH_SETTINGS,
      new AbortController().signal
    )
    expect(accepted.join('')).toBe(text)
    expect(audio.words.map((word) => text.slice(word.charStart, word.charEnd))).toEqual([
      'Hello',
      'hello',
      'hello',
      'hello'
    ])
  })
  it('revokes a cancelled result even when the synthesizer ignores cancellation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = new SpeechService({
      async synthesize() {
        await gate
        return { audio: wav(), words: ['Hello'], wtimes: [0], wdurations: [500] }
      }
    })
    const cancellation = new AbortController()
    const pending = service.synthesize(
      { requestId, text: 'Hello', language: 'en' },
      DEFAULT_SPEECH_SETTINGS,
      cancellation.signal
    )
    cancellation.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    release()
  })
})
