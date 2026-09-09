import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VocabularyError } from '../../core/learning/vocabulary/parse-vocabulary-input'
import {
  VOCABULARY_CHANNELS,
  type ListVocabularyResult,
  type VocabularyPage
} from '../../shared/vocabulary'
import { registerVocabularyIpc, toSafeVocabularyManagementError } from '../vocabulary-ipc'

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  fromWebContents: vi.fn((sender: { owned: boolean }) =>
    sender.owned ? { webContents: sender } : null
  )
}))

vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle, removeHandler: electronMocks.removeHandler },
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents }
}))

const RENDERER_URL = 'file:///app/renderer/index.html'

class FakeSender extends EventEmitter {
  readonly id = 7
  owned = true
  destroyed = false
  mainFrame = { url: RENDERER_URL }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

type IpcHandler = (
  event: { sender: FakeSender; senderFrame?: { url: string } | null },
  input: unknown
) => unknown

function registeredHandler(channel: string): IpcHandler {
  const registration = electronMocks.handle.mock.calls.find(([name]) => name === channel)
  if (!registration) throw new Error(`Missing IPC handler for ${channel}`)
  const handler = registration[1] as IpcHandler
  return (event, input) => handler({ senderFrame: event.sender.mainFrame, ...event }, input)
}

const ENTRY = {
  id: '11111111-1111-4111-8111-111111111111',
  term: 'apple',
  phonetic: '/ˈæpəl/',
  meaning: '苹果，一种水果。',
  concept: '苹果果实。',
  exampleSentences: ['I ate an apple after lunch.'],
  createdAt: '2026-09-07T00:00:00.000Z'
}

function fakeService(
  overrides: Partial<{
    list: (input: unknown) => VocabularyPage
    deleteById: (input: unknown) => { id: string; deleted: boolean }
  }> = {}
): { list: ReturnType<typeof vi.fn>; deleteById: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(overrides.list ?? (() => ({ entries: [ENTRY] }))),
    deleteById: vi.fn(
      overrides.deleteById ?? ((input: { id: string }) => ({ id: input.id, deleted: true }))
    )
  }
}

beforeEach(() => {
  electronMocks.handle.mockReset()
  electronMocks.removeHandler.mockReset()
})

describe('vocabulary IPC', () => {
  it('rejects untrusted callers before touching the service', () => {
    const service = fakeService()
    registerVocabularyIpc(service as never, RENDERER_URL)
    const list = registeredHandler(VOCABULARY_CHANNELS.list)
    const remove = registeredHandler(VOCABULARY_CHANNELS.delete)

    const foreign = new FakeSender()
    foreign.owned = false
    const navigated = new FakeSender()
    navigated.mainFrame = { url: 'https://untrusted.invalid/' }
    const destroyed = new FakeSender()
    destroyed.destroyed = true
    const subFrame = new FakeSender()

    for (const sender of [foreign, navigated, destroyed]) {
      expect(list({ sender }, {})).toEqual({
        status: 'error',
        error: { code: 'UNTRUSTED_SOURCE' }
      })
      expect(remove({ sender }, { id: ENTRY.id })).toEqual({
        status: 'error',
        error: { code: 'UNTRUSTED_SOURCE' }
      })
    }
    expect(list({ sender: subFrame, senderFrame: { url: RENDERER_URL } }, {})).toEqual({
      status: 'error',
      error: { code: 'UNTRUSTED_SOURCE' }
    })
    expect(service.list).not.toHaveBeenCalled()
    expect(service.deleteById).not.toHaveBeenCalled()
  })

  it('rejects inputs outside the predefined window', () => {
    const service = fakeService()
    registerVocabularyIpc(service as never, RENDERER_URL)

    expect(
      registeredHandler(VOCABULARY_CHANNELS.list)({ sender: new FakeSender() }, { limit: 0 })
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(
      registeredHandler(VOCABULARY_CHANNELS.list)({ sender: new FakeSender() }, { sql: 1 })
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(
      registeredHandler(VOCABULARY_CHANNELS.delete)({ sender: new FakeSender() }, { id: 'apple' })
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(registeredHandler(VOCABULARY_CHANNELS.delete)({ sender: new FakeSender() }, {})).toEqual(
      { status: 'error', error: { code: 'INVALID_INPUT' } }
    )
    expect(service.list).not.toHaveBeenCalled()
    expect(service.deleteById).not.toHaveBeenCalled()
  })

  it('returns the parsed page for trusted callers', () => {
    const page: VocabularyPage = {
      entries: [ENTRY],
      nextCursor: { createdAt: ENTRY.createdAt, id: ENTRY.id }
    }
    const service = fakeService({ list: () => page })
    registerVocabularyIpc(service as never, RENDERER_URL)

    expect(service.list).not.toHaveBeenCalled()
    const result = registeredHandler(VOCABULARY_CHANNELS.list)(
      { sender: new FakeSender() },
      {}
    ) as ListVocabularyResult
    expect(result).toEqual({ status: 'ok', entries: [ENTRY], nextCursor: page.nextCursor })
    expect(service.list).toHaveBeenCalledWith({ limit: 50 })
  })

  it('returns idempotent delete outcomes for trusted callers', () => {
    const service = fakeService({
      deleteById: () => ({ id: ENTRY.id, deleted: false })
    })
    registerVocabularyIpc(service as never, RENDERER_URL)

    expect(
      registeredHandler(VOCABULARY_CHANNELS.delete)({ sender: new FakeSender() }, { id: ENTRY.id })
    ).toEqual({ status: 'ok', id: ENTRY.id, deleted: false })
    expect(service.deleteById).toHaveBeenCalledWith({ id: ENTRY.id })
  })

  it('maps core errors to safe codes without internals', () => {
    const service = fakeService()
    service.list.mockImplementation(() => {
      throw new VocabularyError('STORAGE_FAILED', { cause: new Error('sqlite locked') })
    })
    registerVocabularyIpc(service as never, RENDERER_URL)
    const stored = registeredHandler(VOCABULARY_CHANNELS.list)({ sender: new FakeSender() }, {})
    expect(stored).toEqual({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    expect(JSON.stringify(stored)).not.toContain('sqlite')

    service.deleteById.mockImplementation(() => {
      throw new Error('DELETE FROM vocabulary WHERE id = ? at /Users/x/secret.sqlite')
    })
    const unknown = registeredHandler(VOCABULARY_CHANNELS.delete)(
      { sender: new FakeSender() },
      { id: ENTRY.id }
    )
    expect(unknown).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
    expect(JSON.stringify(unknown)).not.toContain('sqlite')
  })

  it('reports a safe error when the result violates the protocol', () => {
    const service = fakeService()
    service.list.mockReturnValue({ entries: [{ ...ENTRY, term: 42 }] } as unknown as VocabularyPage)
    registerVocabularyIpc(service as never, RENDERER_URL)
    expect(registeredHandler(VOCABULARY_CHANNELS.list)({ sender: new FakeSender() }, {})).toEqual({
      status: 'error',
      error: { code: 'UNKNOWN_ERROR' }
    })

    service.deleteById.mockReturnValue({ id: ENTRY.id } as never)
    expect(
      registeredHandler(VOCABULARY_CHANNELS.delete)({ sender: new FakeSender() }, { id: ENTRY.id })
    ).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
  })

  it('unregisters both handlers via the returned cleanup', () => {
    const cleanup = registerVocabularyIpc(fakeService() as never, RENDERER_URL)
    expect(electronMocks.handle).toHaveBeenCalledTimes(2)
    expect(electronMocks.removeHandler).not.toHaveBeenCalled()
    cleanup()
    expect(electronMocks.removeHandler).toHaveBeenCalledWith(VOCABULARY_CHANNELS.list)
    expect(electronMocks.removeHandler).toHaveBeenCalledWith(VOCABULARY_CHANNELS.delete)
  })

  it('maps storage failures exhaustively', () => {
    expect(toSafeVocabularyManagementError(new VocabularyError('STORAGE_FAILED'))).toEqual({
      code: 'STORAGE_FAILED'
    })
    expect(toSafeVocabularyManagementError(new VocabularyError('INVALID_INPUT'))).toEqual({
      code: 'UNKNOWN_ERROR'
    })
    expect(toSafeVocabularyManagementError(new Error('boom'))).toEqual({ code: 'UNKNOWN_ERROR' })
    expect(toSafeVocabularyManagementError('str')).toEqual({ code: 'UNKNOWN_ERROR' })
  })
})
