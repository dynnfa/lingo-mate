import {
  SPEECH_IDENTITY,
  SPEECH_LIMITS,
  speechAudioSchema,
  speechInputSchema,
  speechSettingsSchema,
  type SpeechAudio,
  type SpeechInput,
  type SpeechSettings,
  type SpeechWord
} from '../../shared/speech'
import { joinSpeechPcm, readSpeechWav } from './speech-audio'
import { SpeechError, type SpeechSynthesizer } from './speech-synthesizer'
import { splitSpeechText } from './speech-text'
import { buildSpeechTimeline } from './speech-timeline'

export class SpeechService {
  private tail: Promise<unknown> = Promise.resolve()
  private pending = 0
  private cache = new Map<string, SpeechAudio>()
  constructor(private readonly synthesizer: SpeechSynthesizer) {}

  async synthesize(
    raw: SpeechInput,
    rawSettings: SpeechSettings,
    signal: AbortSignal
  ): Promise<SpeechAudio> {
    const parsed = speechInputSchema.safeParse(raw)
    const config = speechSettingsSchema.safeParse(rawSettings)
    if (!parsed.success || !config.success) throw new SpeechError('INVALID_INPUT')
    if (this.pending >= SPEECH_LIMITS.queue) throw new SpeechError('BUSY')
    const input = parsed.data
    const settings = config.data
    const deadline = AbortSignal.timeout(SPEECH_LIMITS.totalMs)
    const combined = AbortSignal.any([signal, deadline])
    const abortError = (): SpeechError =>
      new SpeechError(deadline.aborted ? 'TIMEOUT' : 'CANCELLED')
    if (combined.aborted) throw abortError()
    this.pending++
    const task = this.tail
      .then(async () => {
        if (combined.aborted) throw abortError()
        const key = JSON.stringify([input.text, input.language, settings, SPEECH_IDENTITY])
        const cached = this.cache.get(key)
        if (cached) return { ...cached, requestId: input.requestId }
        const result = await this.render(input, settings, combined)
        if (combined.aborted) throw abortError()
        if (this.cache.size >= 2) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(key, result)
        return result
      })
      .finally(() => {
        this.pending--
      })
    this.tail = task.catch(() => undefined)
    return new Promise<SpeechAudio>((resolve, reject) => {
      const onAbort = (): void => reject(abortError())
      combined.addEventListener('abort', onAbort, { once: true })
      task.then(resolve, reject).finally(() => combined.removeEventListener('abort', onAbort))
    })
  }

  private async render(
    input: SpeechInput,
    settings: SpeechSettings,
    signal: AbortSignal
  ): Promise<SpeechAudio> {
    const slices = splitSpeechText(input.text)
    const pcm: Uint8Array[] = []
    const words: SpeechWord[] = []
    let durationSeconds = 0
    let completed = 0
    while (slices.length) {
      if (signal.aborted) throw new SpeechError('CANCELLED')
      const slice = slices.shift()!
      try {
        const segment = await this.synthesizer.synthesize(slice.text, settings, signal)
        const wav = readSpeechWav(segment.audio)
        const timeline = buildSpeechTimeline(slice.text, segment, wav.seconds)
        words.push(
          ...timeline.map((word) => ({
            ...word,
            index: words.length + word.index,
            charStart: slice.charStart + word.charStart,
            charEnd: slice.charStart + word.charEnd,
            startSeconds: durationSeconds + word.startSeconds,
            endSeconds: durationSeconds + word.endSeconds
          }))
        )
        pcm.push(wav.pcm)
        durationSeconds += wav.seconds
        completed++
        if (durationSeconds > SPEECH_LIMITS.seconds || words.length > SPEECH_LIMITS.words)
          throw new SpeechError('INVALID_AUDIO')
      } catch (error) {
        if (!(error instanceof SpeechError) || error.code !== 'TOKEN_LIMIT') throw error
        const smaller = splitSpeechText(
          slice.text,
          Math.floor(slice.text.length / 2),
          slice.charStart
        )
        slices.unshift(...smaller)
      }
      if (completed + slices.length > SPEECH_LIMITS.segments) throw new SpeechError('TEXT_LIMIT')
    }
    return speechAudioSchema.parse({
      ...input,
      settings,
      identity: SPEECH_IDENTITY.revision,
      durationSeconds,
      words,
      audio: joinSpeechPcm(pcm)
    })
  }
}
