import { randomUUID } from 'node:crypto'
import {
  SpeechError,
  type SpeechSegment,
  type SpeechSynthesizer
} from '../../core/speech/speech-synthesizer'
import { SPEECH_LIMITS, type SpeechRuntimeStatus, type SpeechSettings } from '../../shared/speech'
import { runtimeResponseSchema } from './headtts-protocol'

export interface SpeechChild {
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'exit', listener: () => void): void
  postMessage(message: unknown): void
  kill(): boolean
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
}

export class HeadTtsProcess implements SpeechSynthesizer {
  private child?: SpeechChild
  private ready?: Promise<void>
  private readyResolve?: () => void
  private readyReject?: (error: Error) => void
  private pending?: {
    id: string
    resolve: (result: SpeechSegment) => void
    reject: (error: Error) => void
  }
  constructor(
    private readonly spawn: () => SpeechChild,
    private readonly modelPath: () => Promise<string>,
    private readonly status: (status: SpeechRuntimeStatus) => void = () => {},
    private readonly diagnostic: (output: string) => void = () => {}
  ) {}

  async synthesize(
    text: string,
    settings: SpeechSettings,
    signal: AbortSignal
  ): Promise<SpeechSegment> {
    if (signal.aborted) throw new SpeechError('CANCELLED')
    const abort = (): void => this.fail(new SpeechError('CANCELLED'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      await this.ensureReady(signal)
      if (signal.aborted) throw new SpeechError('CANCELLED')
      if (this.pending) throw new SpeechError('BUSY')
      const child = this.child!
      return await new Promise<SpeechSegment>((resolve, reject) => {
        const id = randomUUID()
        const timer = setTimeout(
          () => this.fail(new SpeechError('TIMEOUT')),
          SPEECH_LIMITS.segmentMs
        )
        this.pending = {
          id,
          resolve: (result) => {
            clearTimeout(timer)
            resolve(result)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          }
        }
        try {
          child.postMessage({ type: 'synthesize', id, text, settings })
        } catch (cause) {
          this.fail(new SpeechError('RUNTIME_FAILED', { cause }))
        }
      })
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  dispose(): void {
    this.fail(new SpeechError('CANCELLED'))
  }

  private async ensureReady(signal: AbortSignal): Promise<void> {
    if (this.ready) return this.ready
    const modelPath = await this.modelPath()
    if (signal.aborted) throw new SpeechError('CANCELLED')
    this.status({ phase: 'loading', progress: 0 })
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    const ready = this.ready
    const timer = setTimeout(() => this.fail(new SpeechError('TIMEOUT')), SPEECH_LIMITS.loadMs)
    try {
      const child = this.spawn()
      this.child = child
      let logged = 0
      const drain = (chunk: Buffer | string): void => {
        if (logged >= 64 * 1024) return
        const text = String(chunk).slice(0, Math.min(4000, 64 * 1024 - logged))
        logged += text.length
        this.diagnostic(text)
      }
      child.stdout?.on('data', drain)
      child.stderr?.on('data', drain)
      child.on('message', (message) => {
        if (this.child !== child) return
        const parsed = runtimeResponseSchema.safeParse(message)
        if (!parsed.success) {
          this.fail(new SpeechError('RUNTIME_FAILED'))
          return
        }
        const value = parsed.data
        if (value.type === 'ready' && this.readyResolve) {
          this.readyResolve()
          this.readyResolve = undefined
          this.readyReject = undefined
          this.status({ phase: 'ready', progress: 1 })
        } else if (
          (value.type === 'audio' || value.type === 'token-limit') &&
          this.pending?.id === value.id
        ) {
          const pending = this.pending
          this.pending = undefined
          if (value.type === 'audio') pending.resolve(value.segment)
          else pending.reject(new SpeechError('TOKEN_LIMIT'))
        } else {
          this.fail(new SpeechError('RUNTIME_FAILED'))
        }
      })
      child.on('exit', () => {
        if (this.child === child) this.fail(new SpeechError('RUNTIME_FAILED'))
      })
      child.postMessage({ type: 'init', modelPath })
    } catch (cause) {
      this.fail(new SpeechError('RUNTIME_FAILED', { cause }))
    }
    return ready.finally(() => clearTimeout(timer))
  }

  private fail(error: SpeechError): void {
    const child = this.child
    this.child = undefined
    this.ready = undefined
    this.readyReject?.(error)
    this.readyReject = undefined
    this.readyResolve = undefined
    this.pending?.reject(error)
    this.pending = undefined
    child?.kill()
    this.status(
      error.code === 'CANCELLED'
        ? { phase: 'unloaded', progress: 0 }
        : { phase: 'failed', progress: 0, error: error.code }
    )
  }
}
