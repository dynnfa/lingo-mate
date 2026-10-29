import { beforeEach, expect, it, vi } from 'vitest'
import { registerSentenceIpc } from '../sentence-ipc'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import { SentenceManagementService } from '../../core/learning/sentence/sentence-management'
import {
  SentenceError,
  type SentenceRepository
} from '../../core/learning/sentence/sentence-repository'
import { SENTENCE_CHANNELS } from '../../shared/sentence'
import { FakeSender, registeredHandler, RENDERER_URL, resetIpcMocks } from './helpers/ipc-test-env'
vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())
beforeEach(resetIpcMocks)
it('guards caller, validates inputs and results, maps storage errors and deletes idempotently', () => {
  const list = vi.fn(() => ({ entries: [] }))
  const remove = vi.fn(() => false)
  const repository: SentenceRepository = {
    list,
    delete: remove,
    findExisting: vi.fn(),
    commit: vi.fn()
  }
  const dispose = registerSentenceIpc(
    new SentenceManagementService(repository),
    createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })
  )
  const handler = registeredHandler(SENTENCE_CHANNELS.list)
  const sender = new FakeSender()
  const foreign = new FakeSender()
  foreign.owned = false
  expect(handler({ sender: foreign }, {})).toEqual({
    status: 'error',
    error: { code: 'UNTRUSTED_SOURCE' }
  })
  for (const invalid of [
    { limit: 101 },
    { limit: 0 },
    { cursor: { id: 'bad', createdAt: 'bad' } },
    { sql: 'SELECT' }
  ]) {
    expect(handler({ sender }, invalid)).toEqual({
      status: 'error',
      error: { code: 'INVALID_INPUT' }
    })
  }
  expect(list).not.toHaveBeenCalled()
  expect(handler({ sender }, {})).toEqual({ status: 'ok', entries: [] })
  expect(list).toHaveBeenCalledWith({ limit: 50 })
  list.mockImplementationOnce(() => {
    throw new SentenceError('STORAGE_FAILED', { cause: new Error('private sql/path') })
  })
  expect(handler({ sender }, {})).toEqual({ status: 'error', error: { code: 'STORAGE_FAILED' } })
  const id = '11111111-1111-4111-8111-111111111111'
  expect(registeredHandler(SENTENCE_CHANNELS.delete)({ sender }, { id })).toEqual({
    status: 'ok',
    id,
    deleted: false
  })
  expect(remove).toHaveBeenCalledWith(id)
  dispose()
})
