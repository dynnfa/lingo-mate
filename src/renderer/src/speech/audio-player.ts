export interface PreparedSpeechAudio {
  durationSeconds: number
  start(at: number, offset: number, rendered: () => void): { stop(): void }
}
export interface SpeechAudioDevice {
  unlock(): Promise<void>
  decode(bytes: Uint8Array): Promise<PreparedSpeechAudio>
  currentTime(): number
  now(): number
  getState(): AudioContextState | 'interrupted'
  getOutputTimestamp(): { contextTime: number; performanceTime: number }
  close(): Promise<void>
}
export interface AudioCursor {
  positionSeconds: number
  active: boolean
  ended: boolean
  interrupted: boolean
}

export class PlaybackError extends Error {
  readonly code = 'CLOCK_FAILED'
}

export class AudioPlayer {
  private buffer?: PreparedSpeechAudio
  private source?: { stop(): void }
  private generation = 0
  private startAt = 0
  private offset = 0
  private frozen = 0
  private startedMs = 0
  private running = false
  private interrupted = false
  constructor(private readonly device: SpeechAudioDevice) {}
  unlock(): Promise<void> {
    return this.device.unlock()
  }

  async load(bytes: Uint8Array, durationSeconds: number): Promise<boolean> {
    const generation = this.generation
    const buffer = await this.device.decode(bytes)
    if (generation !== this.generation) return false
    if (
      !Number.isFinite(buffer.durationSeconds) ||
      Math.abs(buffer.durationSeconds - durationSeconds) > 1 / 24000
    )
      throw new PlaybackError('Invalid decoded duration')
    this.buffer = buffer
    return true
  }
  async play(offset = this.frozen): Promise<boolean> {
    const buffer = this.buffer
    if (!buffer) throw new PlaybackError('Missing audio')
    this.stopSource()
    const generation = this.generation
    try {
      await this.device.unlock()
    } catch (error) {
      if (generation !== this.generation) return false
      throw error
    }
    if (generation !== this.generation) return false
    if (
      this.device.getState() !== 'running' ||
      !Number.isFinite(offset) ||
      offset < 0 ||
      offset > buffer.durationSeconds
    )
      throw new PlaybackError('Invalid audio context')
    this.offset = offset
    this.interrupted = false
    this.frozen = offset
    this.startAt = this.device.currentTime() + 0.03
    this.startedMs = this.device.now()
    this.running = true
    this.source = buffer.start(this.startAt, offset, () => {
      // Rendering can finish before the device has emitted the final frame.
      // Completion is exclusively determined by read() and the output clock.
    })
    return true
  }
  read(): AudioCursor {
    const duration = this.buffer?.durationSeconds ?? 0
    if (!this.running)
      return {
        positionSeconds: this.frozen,
        active: false,
        ended: false,
        interrupted: this.interrupted
      }
    if (this.device.getState() !== 'running') {
      this.stopSource()
      this.interrupted = true
      return { positionSeconds: this.frozen, active: false, ended: false, interrupted: true }
    }
    const stamp = this.device.getOutputTimestamp()
    const age = (this.device.now() - stamp.performanceTime) / 1000
    if (
      !Number.isFinite(stamp.contextTime) ||
      !Number.isFinite(age) ||
      stamp.contextTime <= 0 ||
      age < -0.001 ||
      age > 0.25
    ) {
      if (this.frozen === this.offset && this.device.now() - this.startedMs < 1000)
        return { positionSeconds: this.frozen, active: false, ended: false, interrupted: false }
      throw new PlaybackError('Invalid output timestamp')
    }
    const outputTime = stamp.contextTime + age
    if (outputTime < this.startAt)
      return { positionSeconds: this.offset, active: false, ended: false, interrupted: false }
    this.frozen = Math.min(duration, Math.max(this.frozen, this.offset + outputTime - this.startAt))
    const ended = this.frozen >= duration
    return { positionSeconds: this.frozen, active: !ended, ended, interrupted: false }
  }
  pause(): number {
    const cursor = this.read()
    this.frozen = cursor.positionSeconds
    this.stopSource()
    this.interrupted = false
    return this.frozen
  }
  seek(seconds: number): void {
    if (
      !this.buffer ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds > this.buffer.durationSeconds
    )
      throw new PlaybackError('Invalid seek')
    this.stopSource()
    this.interrupted = false
    this.frozen = seconds
  }
  stop(): void {
    this.stopSource()
    this.interrupted = false
    this.buffer = undefined
    this.frozen = 0
  }
  async dispose(): Promise<void> {
    this.stop()
    await this.device.close()
  }
  private stopSource(): void {
    this.generation++
    this.running = false
    const source = this.source
    this.source = undefined
    source?.stop()
  }
}

// Browser-only host: the decoded buffer stays inside this closure.
export function createBrowserAudioDevice(): SpeechAudioDevice {
  let context: AudioContext | undefined
  const getContext = (): AudioContext => {
    context ??= new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' })
    return context
  }
  return {
    async unlock() {
      await getContext().resume()
    },
    async decode(bytes) {
      const ctx = getContext()
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      const buffer = await ctx.decodeAudioData(copy.buffer)
      if (buffer.numberOfChannels !== 1) throw new PlaybackError('Invalid audio channels')
      return {
        durationSeconds: buffer.duration,
        start(at, offset, rendered) {
          const source = ctx.createBufferSource()
          source.buffer = buffer
          source.playbackRate.value = 1
          source.connect(ctx.destination)
          source.onended = rendered
          source.start(at, offset)
          return {
            stop() {
              source.onended = null
              source.stop()
              source.disconnect()
            }
          }
        }
      }
    },
    currentTime: () => getContext().currentTime,
    now: () => performance.now(),
    getState: () => getContext().state,
    getOutputTimestamp() {
      const ctx = getContext()
      if (typeof ctx.getOutputTimestamp !== 'function')
        throw new PlaybackError('Output timestamps unavailable')
      const stamp = ctx.getOutputTimestamp()
      return {
        contextTime: stamp.contextTime ?? NaN,
        performanceTime: stamp.performanceTime ?? NaN
      }
    },
    async close() {
      if (context) await context.close()
    }
  }
}
