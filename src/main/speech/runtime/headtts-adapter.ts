import { Worker } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { z } from 'zod'
import { SPEECH_IDENTITY, type SpeechSettings } from '../../../shared/speech'
import { SpeechError, type SpeechSegment } from '../../../core/speech/speech-synthesizer'
import { segmentSchema } from '../headtts-protocol'
import { repairHeadTtsWav } from './headtts-corrections'

const audioMessageSchema = z.object({
  type: z.literal('audio'),
  ref: z.string().uuid(),
  data: z.object({
    audio: z.instanceof(ArrayBuffer),
    words: z.array(z.string()).max(2000),
    wtimes: z.array(z.number()).max(2000),
    wdurations: z.array(z.number()).max(2000),
    audioEncoding: z.literal('wav')
  })
})

// A narrow adapter for the pinned upstream private Worker protocol; no HTTP server.
export class HeadTtsAdapter {
  private worker?: Worker
  private active?: {
    id: string
    resolve: (segment: SpeechSegment) => void
    reject: (error: Error) => void
  }
  async connect(modelPath: string): Promise<void> {
    const require = createRequire(__filename)
    const root = dirname(dirname(require.resolve('@met4citizen/headtts')))
    const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version: string
    }
    const transformerPath = require.resolve('@huggingface/transformers')
    if (
      createRequire(join(root, 'package.json')).resolve('@huggingface/transformers') !==
      transformerPath
    )
      throw new SpeechError('RUNTIME_FAILED')
    const transformerVersion = JSON.parse(
      await readFile(join(dirname(dirname(transformerPath)), 'package.json'), 'utf8')
    ) as { version: string }
    if (
      version.version !== SPEECH_IDENTITY.headtts ||
      transformerVersion.version !== SPEECH_IDENTITY.transformers
    )
      throw new SpeechError('RUNTIME_FAILED')
    const worker = new Worker(join(__dirname, 'headtts-worker.js'), {
      workerData: { modelPath, headttsRoot: root }
    })
    this.worker = worker
    await new Promise<void>((resolve, reject) => {
      let connected = false
      worker.on('error', (error) => {
        reject(error)
        this.active?.reject(error)
        this.active = undefined
      })
      worker.on('exit', () => {
        const error = new SpeechError('RUNTIME_FAILED')
        reject(error)
        this.active?.reject(error)
        this.active = undefined
      })
      worker.on('message', (raw: unknown) => {
        const message = raw as { type?: string; ref?: string }
        if (message.type === 'booted') {
          worker.postMessage({
            type: 'connect',
            data: {
              transformersModule: '@huggingface/transformers',
              model: modelPath,
              dtype: 'fp32',
              device: 'cpu',
              styleDim: 256,
              frameRate: 40,
              audioSampleRate: 24000,
              languages: ['en-us'],
              dictionaryPath: join(root, 'dictionaries'),
              voicePath: join(modelPath, 'voices'),
              voices: [],
              deltaStart: 0,
              deltaEnd: 0,
              trace: 0
            }
          })
        } else if (message.type === 'ready' && !connected) {
          connected = true
          resolve()
        } else if (message.type === 'progress') {
          /* loading is bounded by the host deadline */
        } else if (this.active && this.active.id === message.ref) {
          const active = this.active
          this.active = undefined
          if (message.type === 'token-limit') {
            active.reject(new SpeechError('TOKEN_LIMIT'))
            return
          }
          const result = audioMessageSchema.safeParse(raw)
          if (!result.success) {
            active.reject(new SpeechError('RUNTIME_FAILED'))
            return
          }
          const { audio, words, wtimes, wdurations } = result.data.data
          try {
            const segment = segmentSchema.safeParse({
              audio: repairHeadTtsWav(audio),
              words,
              wtimes,
              wdurations
            })
            if (segment.success) active.resolve(segment.data)
            else active.reject(new SpeechError('RUNTIME_FAILED'))
          } catch (error) {
            active.reject(error instanceof Error ? error : new SpeechError('RUNTIME_FAILED'))
          }
        } else {
          const error = new SpeechError('RUNTIME_FAILED')
          reject(error)
          this.active?.reject(error)
          this.active = undefined
          void worker.terminate()
        }
      })
    })
  }
  synthesize(id: string, text: string, settings: SpeechSettings): Promise<SpeechSegment> {
    if (!this.worker || this.active) return Promise.reject(new SpeechError('BUSY'))
    return new Promise((resolve, reject) => {
      this.active = { id, resolve, reject }
      this.worker!.postMessage({
        type: 'synthesize',
        id,
        data: {
          input: text,
          voice: settings.voice,
          speed: settings.speed,
          language: 'en-us',
          audioEncoding: 'wav'
        }
      })
    })
  }
}
