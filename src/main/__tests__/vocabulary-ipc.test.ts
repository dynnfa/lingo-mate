import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VocabularyModule } from '../../core/learning/vocabulary/vocabulary-module'
import { memoryRepository, recognized } from '../../core/learning/vocabulary/__tests__/fixtures'
import { VocabularyError } from '../../core/learning/vocabulary/parse-vocabulary-input'
import { registerVocabularyIpc } from '../vocabulary-ipc'
import {
  VOCABULARY_CHANNELS,
  addVocabularyBatchResultSchema,
  listVocabularyResultSchema
} from '../../shared/vocabulary'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: mocks,
  BrowserWindow: {
    fromWebContents: (sender: { owned: boolean }) => (sender.owned ? { webContents: sender } : null)
  }
}))
const url = 'file:///app/renderer/index.html'
class Sender extends EventEmitter {
  owned = true
  destroyed = false
  mainFrame = { url }
  constructor(readonly id: number) {
    super()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}
type Handler = (
  event: { sender: Sender; senderFrame: { url: string } | null },
  raw: unknown
) => unknown
function invoke(
  channel: string,
  sender: Sender,
  input: unknown,
  frame = sender.mainFrame
): unknown {
  const handler = mocks.handle.mock.calls.find((call) => call[0] === channel)?.[1] as Handler
  return handler({ sender, senderFrame: frame }, input)
}
const request = (text = 'apple'): { requestId: string; text: string; wordLanguage: string } => ({
  requestId: randomUUID(),
  text,
  wordLanguage: 'en'
})
let dispose: (() => void) | undefined
beforeEach(() => vi.clearAllMocks())
afterEach(() => dispose?.())
describe('vocabulary IPC', () => {
  it.each(Object.values(VOCABULARY_CHANNELS))(
    'rejects untrusted windows and non-main frames on %s',
    async (channel) => {
      const repository = memoryRepository()
      const create = vi.fn(() => ({ analyze: async () => recognized() }))
      dispose = registerVocabularyIpc(
        new VocabularyModule(repository, create),
        repository,
        () => 'en',
        url
      )
      const foreign = new Sender(1)
      foreign.owned = false
      const navigated = new Sender(2)
      navigated.mainFrame.url = 'https://other.invalid'
      const dead = new Sender(3)
      dead.destroyed = true
      const trusted = new Sender(4)
      for (const sender of [foreign, navigated, dead]) {
        expect(await invoke(channel, sender, request())).toEqual({
          status: 'error',
          error: { code: 'UNTRUSTED_SOURCE' }
        })
      }
      expect(await invoke(channel, trusted, request(), { url })).toEqual({
        status: 'error',
        error: { code: 'UNTRUSTED_SOURCE' }
      })
      expect(create).not.toHaveBeenCalled()
    }
  )
  it('validates inputs and returns only safe error codes', async () => {
    const repository = memoryRepository()
    dispose = registerVocabularyIpc(
      new VocabularyModule(repository, () => ({ analyze: async () => recognized() })),
      repository,
      () => 'en',
      url
    )
    const sender = new Sender(1)
    for (const raw of [
      {},
      { ...request(), wordLanguage: 'fr' },
      request('， ,'),
      request('a'.repeat(101))
    ]) {
      expect(await invoke(VOCABULARY_CHANNELS.addBatch, sender, raw)).toEqual({
        status: 'error',
        error: { code: 'INVALID_INPUT' }
      })
    }
    expect(await invoke(VOCABULARY_CHANNELS.list, sender, { limit: 200 })).toEqual({
      status: 'error',
      error: { code: 'INVALID_INPUT' }
    })
    repository.list = () => {
      throw new VocabularyError('STORAGE_FAILED', { cause: new Error('private path') })
    }
    expect(await invoke(VOCABULARY_CHANNELS.list, sender, {})).toEqual({
      status: 'error',
      error: { code: 'STORAGE_FAILED' }
    })
  })
  it('enforces one batch per sender, active ID uniqueness, cancel ownership, and destruction cleanup', async () => {
    const repository = memoryRepository()
    const analyze = vi.fn(() => new Promise<ReturnType<typeof recognized>>(() => {}))
    dispose = registerVocabularyIpc(
      new VocabularyModule(repository, () => ({ analyze })),
      repository,
      () => 'en',
      url
    )
    const first = new Sender(1)
    const other = new Sender(2)
    const input = request()
    const pending = invoke(VOCABULARY_CHANNELS.addBatch, first, input)
    expect(await invoke(VOCABULARY_CHANNELS.addBatch, first, request())).toEqual({
      status: 'error',
      error: { code: 'BUSY' }
    })
    expect(await invoke(VOCABULARY_CHANNELS.addBatch, other, input)).toEqual({
      status: 'error',
      error: { code: 'BUSY' }
    })
    expect(
      await invoke(VOCABULARY_CHANNELS.cancelBatch, other, { requestId: input.requestId })
    ).toEqual({ status: 'error', error: { code: 'REQUEST_NOT_FOUND' } })
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce())
    first.destroyed = true
    first.emit('destroyed')
    expect(await pending).toMatchObject({ status: 'ok', batch: { outcome: 'cancelled' } })
    expect(first.listenerCount('destroyed')).toBe(0)
    expect(repository.entries).toHaveLength(0)
  })
  it('fixes batch language and returns too_late for cancellation queued after commit', async () => {
    const repository = memoryRepository()
    let language: 'en' | 'zh-CN' = 'en'
    const analyze = vi.fn(async () => {
      language = 'zh-CN'
      return recognized()
    })
    dispose = registerVocabularyIpc(
      new VocabularyModule(repository, () => ({ analyze })),
      repository,
      () => language,
      url
    )
    const sender = new Sender(1)
    const input = request('apple,banana,orange')
    const result = await invoke(VOCABULARY_CHANNELS.addBatch, sender, input)
    expect(addVocabularyBatchResultSchema.safeParse(result).success).toBe(true)
    expect(result).toMatchObject({
      status: 'ok',
      batch: { explanationLanguage: 'en', counts: { saved: 3 } }
    })
    expect(repository.entries.every((entry) => entry.explanationLanguage === 'en')).toBe(true)
    expect(
      await invoke(VOCABULARY_CHANNELS.cancelBatch, sender, { requestId: input.requestId })
    ).toEqual({ status: 'ok', outcome: 'too_late' })
    // The repository fixture contains internal metadata; boundary validation rejects that projection.
    repository.list = () => ({ entries: [] })
    expect(
      listVocabularyResultSchema.safeParse(await invoke(VOCABULARY_CHANNELS.list, sender, {}))
        .success
    ).toBe(true)
  })
  it('disposes active work and all listeners before database shutdown', async () => {
    const repository = memoryRepository()
    const module = new VocabularyModule(repository, () => ({
      analyze: () => new Promise(() => {})
    }))
    dispose = registerVocabularyIpc(module, repository, () => 'en', url)
    const sender = new Sender(1)
    const pending = invoke(VOCABULARY_CHANNELS.addBatch, sender, request())
    dispose()
    expect(await pending).toMatchObject({ status: 'ok', batch: { outcome: 'cancelled' } })
    expect(repository.entries).toHaveLength(0)
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(mocks.removeHandler).toHaveBeenCalledTimes(3)
    dispose = undefined
  })
})
