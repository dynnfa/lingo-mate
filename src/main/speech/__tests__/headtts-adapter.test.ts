import { describe, expect, it, vi } from 'vitest'
import { HeadTtsAdapter } from '../runtime/headtts-adapter'

const workers = vi.hoisted(() => ({
  instances: [] as Array<{ emit(event: string, message: unknown): boolean }>
}))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super()
        workers.instances.push(this)
      }
      postMessage(): void {
        /* controlled worker */
      }
      terminate(): Promise<number> {
        return Promise.resolve(0)
      }
    }
  }
})
describe('pinned Worker protocol adapter', () => {
  it('turns malformed audio into an explicit request failure without throwing out of the message listener', async () => {
    const adapter = new HeadTtsAdapter()
    const connecting = adapter.connect('/isolated/test/model')
    await vi.waitFor(() => expect(workers.instances).toHaveLength(1))
    const worker = workers.instances[0]
    worker.emit('message', { type: 'booted' })
    worker.emit('message', { type: 'ready' })
    await connecting
    const id = 'a5c2281c-b5de-4f88-809e-04cab8af2c87'
    const pending = adapter.synthesize(id, 'hello', { voice: 'af_bella', speed: 1 })
    const failure = expect(pending).rejects.toMatchObject({ code: 'INVALID_AUDIO' })
    expect(() =>
      worker.emit('message', {
        type: 'audio',
        ref: id,
        data: {
          audio: new ArrayBuffer(46),
          audioEncoding: 'wav',
          words: ['hello'],
          wtimes: [0],
          wdurations: [100]
        }
      })
    ).not.toThrow()
    await failure
  })
})
