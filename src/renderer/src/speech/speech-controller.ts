import {
  speechErrorCodeSchema,
  type SpeechApi,
  type SpeechAudio,
  type SpeechErrorCode,
  type SpeechWord
} from '../../../shared/speech'
import { AudioPlayer, createBrowserAudioDevice } from './audio-player'
import { findSpeechWord } from './word-position'

export interface PlaybackSnapshot {
  playbackId: number
  sourceId: string | null
  text: string
  status:
    | 'idle'
    | 'loading'
    | 'ready'
    | 'synthesizing'
    | 'playing'
    | 'paused'
    | 'completed'
    | 'cancelled'
    | 'failed'
  positionSeconds: number
  durationSeconds: number
  currentWord: SpeechWord | null
  isPlaying: boolean
  error?: SpeechErrorCode
}
const initial = (): PlaybackSnapshot => ({
  playbackId: 0,
  sourceId: null,
  text: '',
  status: 'idle',
  positionSeconds: 0,
  durationSeconds: 0,
  currentWord: null,
  isPlaying: false
})
interface Frames {
  request(callback: () => void): number
  cancel(id: number): void
}

export class SpeechController {
  private state = initial()
  private listeners = new Set<() => void>()
  private generation = 0
  private requestId?: string
  private audio?: SpeechAudio
  private frame?: number
  constructor(
    private readonly api: Pick<SpeechApi, 'synthesize' | 'cancel'>,
    private readonly player: AudioPlayer,
    private readonly frames: Frames = {
      request: (fn) => requestAnimationFrame(fn),
      cancel: (id) => cancelAnimationFrame(id)
    },
    private readonly uuid: () => string = () => crypto.randomUUID()
  ) {}
  getState = (): PlaybackSnapshot => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getPlaybackSnapshot = (): PlaybackSnapshot => {
    try {
      return this.derive()
    } catch {
      this.fail('CLOCK_FAILED')
      return this.state
    }
  }
  async loadSaved(
    sourceId: string,
    text: string,
    load: () => ReturnType<SpeechApi['synthesize']>,
    offset = 0
  ): Promise<boolean> {
    this.stop()
    const generation = this.generation
    this.publish({ ...initial(), playbackId: generation, sourceId, text, status: 'loading' })
    try {
      const result = await load()
      if (generation !== this.generation) return false
      if (result.status === 'error') {
        this.fail(result.error.code)
        return false
      }
      if (result.result.text !== text) {
        this.fail('INVALID_AUDIO')
        return false
      }
      if (
        !(await this.player.load(result.result.audio, result.result.durationSeconds)) ||
        generation !== this.generation
      )
        return false
      this.audio = result.result
      this.player.seek(offset)
      this.publish({
        ...this.state,
        status: 'ready',
        durationSeconds: result.result.durationSeconds,
        positionSeconds: offset,
        currentWord: findSpeechWord(result.result.words, offset)
      })
      return true
    } catch {
      if (generation === this.generation) this.fail('INVALID_AUDIO')
      return false
    }
  }
  async playSaved(
    sourceId: string,
    text: string,
    load: () => ReturnType<SpeechApi['synthesize']>
  ): Promise<void> {
    if (
      this.state.sourceId === sourceId &&
      this.state.text === text &&
      ['ready', 'paused', 'completed'].includes(this.state.status)
    ) {
      await this.resume()
      return
    }
    // Unlock while the play-button gesture is active, before awaiting IPC/decode.
    const unlocked = this.player.unlock()
    const pending = this.loadSaved(sourceId, text, load)
    const generation = this.generation
    try {
      const [loaded] = await Promise.all([pending, unlocked])
      if (loaded && generation === this.generation) await this.resume()
    } catch {
      if (generation === this.generation) this.fail('CLOCK_FAILED')
    }
  }
  async speak(sourceId: string, text: string): Promise<void> {
    this.stop()
    const generation = this.generation
    const requestId = this.uuid()
    this.requestId = requestId
    this.publish({ ...initial(), playbackId: generation, sourceId, text, status: 'synthesizing' })
    try {
      // Resume in the user gesture, before waiting for synthesis/IPC.
      const unlocked = this.player.unlock()
      const pending = this.api.synthesize({ requestId, text, language: 'en' })
      const [result] = await Promise.all([pending, unlocked])
      if (generation !== this.generation) return
      this.requestId = undefined
      if (result.status === 'error') {
        this.fail(result.error.code)
        return
      }
      this.audio = result.result
      if (
        !(await this.player.load(result.result.audio, result.result.durationSeconds)) ||
        generation !== this.generation
      )
        return
      if (!(await this.player.play(0)) || generation !== this.generation) return
      this.requestId = undefined
      this.publish({
        ...this.state,
        durationSeconds: result.result.durationSeconds,
        status: 'playing'
      })
      this.tick()
    } catch (error) {
      if (generation !== this.generation) return
      const parsed = speechErrorCodeSchema.safeParse((error as { code?: unknown })?.code)
      this.fail(parsed.success ? parsed.data : 'RUNTIME_FAILED')
    }
  }
  pause = (): void => {
    if (this.state.status !== 'playing') return
    try {
      const positionSeconds = this.player.pause()
      this.cancelFrame()
      this.publish({
        ...this.state,
        status: 'paused',
        positionSeconds,
        currentWord: findSpeechWord(this.audio?.words ?? [], positionSeconds),
        isPlaying: false
      })
    } catch {
      this.fail('CLOCK_FAILED')
    }
  }
  resume = async (): Promise<void> => {
    if (!['ready', 'paused', 'completed'].includes(this.state.status)) return
    const generation = this.generation
    try {
      if (
        !(await this.player.play(
          this.state.status === 'completed' ? 0 : this.state.positionSeconds
        )) ||
        generation !== this.generation
      )
        return
      this.publish({ ...this.state, status: 'playing' })
      this.tick()
    } catch {
      if (generation === this.generation) this.fail('CLOCK_FAILED')
    }
  }
  seek = async (seconds: number): Promise<void> => {
    if (!['ready', 'playing', 'paused', 'completed'].includes(this.state.status)) return
    const generation = this.generation
    const playing = this.state.status === 'playing'
    try {
      this.player.seek(seconds)
      this.publish({
        ...this.state,
        status: this.state.status === 'completed' ? 'ready' : this.state.status,
        positionSeconds: seconds,
        currentWord: playing ? null : findSpeechWord(this.audio?.words ?? [], seconds),
        isPlaying: false
      })
      if (playing && !(await this.player.play(seconds))) return
      if (generation === this.generation && playing) this.tick()
    } catch {
      if (generation === this.generation) this.fail('CLOCK_FAILED')
    }
  }
  stop = (): void => {
    this.generation++
    this.cancelFrame()
    this.player.stop()
    const requestId = this.requestId
    this.requestId = undefined
    if (requestId) void this.api.cancel({ requestId }).catch(() => undefined)
    this.audio = undefined
    this.publish({
      ...initial(),
      playbackId: this.generation,
      status: this.state.status === 'idle' ? 'idle' : 'cancelled'
    })
  }
  stopSource(sourceId: string): void {
    if (this.state.sourceId === sourceId) this.stop()
  }
  refresh = (): void => {
    if (this.state.status === 'playing') this.tick()
  }

  private derive(): PlaybackSnapshot {
    if (this.state.status !== 'playing') return this.state
    const cursor = this.player.read()
    const status = cursor.ended ? 'completed' : cursor.interrupted ? 'paused' : 'playing'
    return {
      ...this.state,
      status,
      positionSeconds: cursor.positionSeconds,
      isPlaying: cursor.active,
      currentWord: cursor.ended
        ? null
        : cursor.active || cursor.interrupted
          ? findSpeechWord(this.audio?.words ?? [], cursor.positionSeconds)
          : null
    }
  }
  private tick = (): void => {
    this.cancelFrame()
    try {
      this.publish(this.derive())
      if (this.state.status === 'playing') this.frame = this.frames.request(this.tick)
    } catch {
      this.fail('CLOCK_FAILED')
    }
  }
  private fail(error: SpeechErrorCode): void {
    this.cancelFrame()
    this.player.stop()
    this.audio = undefined
    const requestId = this.requestId
    this.requestId = undefined
    if (requestId) void this.api.cancel({ requestId }).catch(() => undefined)
    this.publish({
      ...this.state,
      status: error === 'CANCELLED' ? 'cancelled' : 'failed',
      currentWord: null,
      isPlaying: false,
      error
    })
  }
  private publish(state: PlaybackSnapshot): void {
    this.state = state
    this.listeners.forEach((listener) => listener())
  }
  private cancelFrame(): void {
    if (this.frame !== undefined) this.frames.cancel(this.frame)
    this.frame = undefined
  }
}

let singleton: SpeechController | undefined
export function getSpeechController(): SpeechController {
  singleton ??= new SpeechController(window.api.speech, new AudioPlayer(createBrowserAudioDevice()))
  return singleton
}
