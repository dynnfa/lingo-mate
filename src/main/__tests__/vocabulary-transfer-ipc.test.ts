import { beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { registerVocabularyTransferIpc } from '../vocabulary-transfer-ipc'
import { VocabularyTransferService } from '../../core/learning/vocabulary/vocabulary-transfer'
import { memoryRepository } from '../../core/learning/vocabulary/__tests__/fixtures'
import {
  VOCABULARY_COLUMNS,
  VOCABULARY_TRANSFER_CHANNELS as C
} from '../../shared/vocabulary-transfer'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import { FakeSender, registeredHandler, RENDERER_URL, resetIpcMocks } from './helpers/ipc-test-env'
vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())
beforeEach(resetIpcMocks)
it('guards sources and payloads, binds confirmation to the window and releases previews on destruction', async () => {
  const service = new VocabularyTransferService(memoryRepository(), () => ({ analyze: vi.fn() }))
  const files = {
    preview: vi.fn(async () => [{ row: 1, cells: [...VOCABULARY_COLUMNS] }]),
    save: vi.fn(async () => true)
  }
  const dispose = registerVocabularyTransferIpc(
    service,
    files,
    () => 'en',
    createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })
  )
  const sender = new FakeSender()
  sender.owned = false
  expect(await registeredHandler(C.preview)({ sender }, undefined)).toMatchObject({
    status: 'error',
    error: { code: 'UNTRUSTED_SOURCE' }
  })
  expect(files.preview).not.toHaveBeenCalled()
  sender.owned = true
  expect(
    await registeredHandler(C.confirm)({ sender }, { importId: randomUUID(), rows: [] })
  ).toMatchObject({ status: 'error', error: { code: 'INVALID_INPUT' } })
  const result = (await registeredHandler(C.preview)({ sender }, undefined)) as {
    preview: { importId: string }
  }
  const foreign = new FakeSender()
  Object.defineProperty(foreign, 'id', { value: 8 })
  expect(
    await registeredHandler(C.confirm)({ sender: foreign }, { importId: result.preview.importId })
  ).toMatchObject({ status: 'error', error: { code: 'PREVIEW_EXPIRED' } })
  sender.destroy()
  expect(() => service.confirm(7, result.preview.importId)).toThrow()
  dispose()
})
