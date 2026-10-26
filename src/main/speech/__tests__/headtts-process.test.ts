import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { HeadTtsProcess } from '../headtts-process'
import { SPEECH_IDENTITY, DEFAULT_SPEECH_SETTINGS } from '../../../shared/speech'

class Child extends EventEmitter {
  sent: unknown[] = []
  killed = false
  postMessage(message: unknown): void {
    this.sent.push(message)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
}
describe('isolated HeadTTS process', () => {
  it('refuses a runtime claiming any precision other than the pinned FP32 identity', async () => {
    const child = new Child()
    const runtime = new HeadTtsProcess(
      () => child,
      async () => '/temporary/model'
    )
    const pending = runtime.synthesize(
      'Hello',
      DEFAULT_SPEECH_SETTINGS,
      new AbortController().signal
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    child.emit('message', { type: 'ready', identity: { ...SPEECH_IDENTITY, dtype: 'fp16' } })
    await expect(pending).rejects.toMatchObject({ code: 'RUNTIME_FAILED' })
    expect(child.killed).toBe(true)
    expect(child.sent).toHaveLength(1)
  })
})
