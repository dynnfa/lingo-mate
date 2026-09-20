import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VocabularyMistakesError } from '../../core/learning/vocabulary-practice/parse-vocabulary-mistakes-input'
import {
  VOCABULARY_MISTAKES_CHANNELS,
  VOCABULARY_MISTAKES_LIMIT_DEFAULT,
  type ListVocabularyMistakeHistoryResult,
  type ListVocabularyMistakesResult
} from '../../shared/vocabulary-mistakes'
import {
  registerVocabularyMistakesIpc,
  toSafeVocabularyMistakesError
} from '../vocabulary-mistakes-ipc'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import { FakeSender, registeredHandler, RENDERER_URL, resetIpcMocks } from './helpers/ipc-test-env'

vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())

const registerTrustedHandler = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'
const STAMP = '2026-09-20T00:00:00.000Z'

const LIST_ITEM = {
  entryId: UUID,
  term: 'apple',
  lastSubmittedMeaning: '一种水果',
  totalMistakes: 2,
  lastErrorAt: STAMP
}
const HISTORY_ITEM = { id: UUID2, submittedMeaning: '一种水果', createdAt: STAMP }

function fakeService(
  overrides: Partial<{
    list: (input: unknown) => unknown
    listHistory: (input: unknown) => unknown
  }> = {}
): { list: ReturnType<typeof vi.fn>; listHistory: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(overrides.list ?? (() => ({ entries: [LIST_ITEM] }))),
    listHistory: vi.fn(overrides.listHistory ?? (() => ({ items: [HISTORY_ITEM] })))
  }
}

function register(
  service: ReturnType<typeof fakeService> = fakeService()
): ReturnType<typeof fakeService> {
  registerVocabularyMistakesIpc(service as never, registerTrustedHandler)
  return service
}

beforeEach(resetIpcMocks)

describe('vocabulary mistakes IPC', () => {
  it('rejects untrusted callers before touching the service', async () => {
    const service = register()
    const list = registeredHandler(VOCABULARY_MISTAKES_CHANNELS.list)
    const listHistory = registeredHandler(VOCABULARY_MISTAKES_CHANNELS.listHistory)

    const foreign = new FakeSender()
    foreign.owned = false
    const navigated = new FakeSender()
    navigated.mainFrame = { url: 'https://untrusted.invalid/' }
    const destroyed = new FakeSender()
    destroyed.destroyed = true

    for (const sender of [foreign, navigated, destroyed]) {
      expect(await list({ sender }, {})).toEqual({
        status: 'error',
        error: { code: 'UNTRUSTED_SOURCE' }
      })
      expect(await listHistory({ sender }, {})).toEqual({
        status: 'error',
        error: { code: 'UNTRUSTED_SOURCE' }
      })
    }
    expect(service.list).not.toHaveBeenCalled()
    expect(service.listHistory).not.toHaveBeenCalled()
  })

  it('rejects inputs outside the predefined window', async () => {
    const service = register()
    const list = registeredHandler(VOCABULARY_MISTAKES_CHANNELS.list)
    const listHistory = registeredHandler(VOCABULARY_MISTAKES_CHANNELS.listHistory)
    const sender = { sender: new FakeSender() }

    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: '10' }, { extra: 1 }]) {
      expect(await list(sender, input)).toEqual({
        status: 'error',
        error: { code: 'INVALID_INPUT' }
      })
    }
    expect(await list(sender, { cursor: { lastErrorAt: 'not-a-date', entryId: UUID } })).toEqual({
      status: 'error',
      error: { code: 'INVALID_INPUT' }
    })
    for (const input of [{ entryId: 'not-a-uuid' }, {}, { entryId: UUID, limit: 0 }]) {
      expect(await listHistory(sender, input)).toEqual({
        status: 'error',
        error: { code: 'INVALID_INPUT' }
      })
    }
    expect(service.list).not.toHaveBeenCalled()
    expect(service.listHistory).not.toHaveBeenCalled()
  })

  it('passes guard-validated input with the default limit to the service', async () => {
    const service = register()
    const list = registeredHandler(VOCABULARY_MISTAKES_CHANNELS.list)
    const listHistory = registeredHandler(VOCABULARY_MISTAKES_CHANNELS.listHistory)
    const sender = { sender: new FakeSender() }

    await list(sender, {})
    await listHistory(sender, { entryId: UUID })

    // 校验后的输入（含 limit 默认值补全）由此进入可信调用链，后续层不再重复校验
    expect(service.list).toHaveBeenCalledWith({ limit: VOCABULARY_MISTAKES_LIMIT_DEFAULT })
    expect(service.listHistory).toHaveBeenCalledWith({
      entryId: UUID,
      limit: VOCABULARY_MISTAKES_LIMIT_DEFAULT
    })
  })

  it('returns aggregate pages and omits exhausted cursors', async () => {
    register()
    const list = registeredHandler(VOCABULARY_MISTAKES_CHANNELS.list)
    const result = (await list(
      { sender: new FakeSender() },
      {
        limit: 10
      }
    )) as ListVocabularyMistakesResult
    expect(result).toEqual({ status: 'ok', entries: [LIST_ITEM] })
  })

  it('returns history pages with optional cursors', async () => {
    register(
      fakeService({
        listHistory: () => ({
          items: [HISTORY_ITEM],
          nextCursor: { createdAt: STAMP, id: UUID }
        })
      })
    )
    const listHistory = registeredHandler(VOCABULARY_MISTAKES_CHANNELS.listHistory)
    const result = (await listHistory(
      { sender: new FakeSender() },
      { entryId: UUID }
    )) as ListVocabularyMistakeHistoryResult
    expect(result).toEqual({
      status: 'ok',
      items: [HISTORY_ITEM],
      nextCursor: { createdAt: STAMP, id: UUID }
    })
  })

  it('maps domain storage failures to STORAGE_FAILED and others to UNKNOWN_ERROR', async () => {
    register(
      fakeService({
        list: () => {
          throw new VocabularyMistakesError('STORAGE_FAILED')
        },
        listHistory: () => {
          throw new Error('unexpected')
        }
      })
    )
    const list = registeredHandler(VOCABULARY_MISTAKES_CHANNELS.list)
    const listHistory = registeredHandler(VOCABULARY_MISTAKES_CHANNELS.listHistory)
    const sender = { sender: new FakeSender() }
    expect(await list(sender, {})).toEqual({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    expect(await listHistory(sender, { entryId: UUID })).toEqual({
      status: 'error',
      error: { code: 'UNKNOWN_ERROR' }
    })
  })

  it('converts only safe codes at the process boundary', () => {
    expect(toSafeVocabularyMistakesError(new VocabularyMistakesError('STORAGE_FAILED'))).toEqual({
      code: 'STORAGE_FAILED'
    })
    expect(toSafeVocabularyMistakesError(new Error('database path leak'))).toEqual({
      code: 'UNKNOWN_ERROR'
    })
    expect(toSafeVocabularyMistakesError(undefined)).toEqual({ code: 'UNKNOWN_ERROR' })
  })
})
