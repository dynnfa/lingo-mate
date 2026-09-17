import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PhraseError } from '../../core/learning/phrase/parse-phrase-input'
import { PHRASE_CHANNELS, type ListPhraseResult, type PhrasePage } from '../../shared/phrase'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import { registerPhraseIpc, toSafePhraseManagementError } from '../phrase-ipc'
import {
  electronMocks,
  FakeSender,
  registeredHandler,
  RENDERER_URL,
  resetIpcMocks
} from './helpers/ipc-test-env'

vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())

const registerTrustedHandler = createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL })

const ENTRY = {
  phrase: 'look forward to',
  explantation: '期待，盼望（某件将发生的事）。',
  example: 'I look forward to hearing from you.'
}

function fakeService(
  overrides: Partial<{
    list: (input: unknown) => PhrasePage
    deleteByPhrase: (input: unknown) => { phrase: string; deleted: boolean }
  }> = {}
): { list: ReturnType<typeof vi.fn>; deleteByPhrase: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(overrides.list ?? (() => ({ entries: [ENTRY] }))),
    deleteByPhrase: vi.fn(
      overrides.deleteByPhrase ??
        ((input: { phrase: string }) => ({ phrase: input.phrase, deleted: true }))
    )
  }
}

beforeEach(resetIpcMocks)

describe('phrase IPC', () => {
  it('rejects untrusted callers before touching the service', () => {
    const service = fakeService()
    registerPhraseIpc(service as never, registerTrustedHandler)
    const list = registeredHandler(PHRASE_CHANNELS.list)
    const remove = registeredHandler(PHRASE_CHANNELS.delete)

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
      expect(remove({ sender }, { phrase: ENTRY.phrase })).toEqual({
        status: 'error',
        error: { code: 'UNTRUSTED_SOURCE' }
      })
    }
    expect(list({ sender: subFrame, senderFrame: { url: RENDERER_URL } }, {})).toEqual({
      status: 'error',
      error: { code: 'UNTRUSTED_SOURCE' }
    })
    expect(service.list).not.toHaveBeenCalled()
    expect(service.deleteByPhrase).not.toHaveBeenCalled()
  })

  it('rejects inputs outside the predefined window', () => {
    const service = fakeService()
    registerPhraseIpc(service as never, registerTrustedHandler)

    expect(
      registeredHandler(PHRASE_CHANNELS.list)({ sender: new FakeSender() }, { limit: 0 })
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(
      registeredHandler(PHRASE_CHANNELS.list)({ sender: new FakeSender() }, { sql: 1 })
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(
      registeredHandler(PHRASE_CHANNELS.delete)({ sender: new FakeSender() }, { phrase: '' })
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(registeredHandler(PHRASE_CHANNELS.delete)({ sender: new FakeSender() }, {})).toEqual({
      status: 'error',
      error: { code: 'INVALID_INPUT' }
    })
    expect(service.list).not.toHaveBeenCalled()
    expect(service.deleteByPhrase).not.toHaveBeenCalled()
  })

  it('returns the parsed page for trusted callers', () => {
    const page: PhrasePage = {
      entries: [ENTRY],
      nextCursor: 'piece of cake'
    }
    const service = fakeService({ list: () => page })
    registerPhraseIpc(service as never, registerTrustedHandler)

    expect(service.list).not.toHaveBeenCalled()
    const result = registeredHandler(PHRASE_CHANNELS.list)(
      { sender: new FakeSender() },
      {}
    ) as ListPhraseResult
    expect(result).toEqual({ status: 'ok', entries: [ENTRY], nextCursor: 'piece of cake' })
    expect(service.list).toHaveBeenCalledWith({ limit: 50 })
  })

  it('returns idempotent delete outcomes for trusted callers', () => {
    const service = fakeService({
      deleteByPhrase: () => ({ phrase: ENTRY.phrase, deleted: false })
    })
    registerPhraseIpc(service as never, registerTrustedHandler)

    expect(
      registeredHandler(PHRASE_CHANNELS.delete)(
        { sender: new FakeSender() },
        { phrase: ENTRY.phrase }
      )
    ).toEqual({ status: 'ok', phrase: ENTRY.phrase, deleted: false })
    expect(service.deleteByPhrase).toHaveBeenCalledWith({ phrase: ENTRY.phrase })
  })

  it('maps core errors to safe codes without internals', () => {
    const service = fakeService()
    service.list.mockImplementation(() => {
      throw new PhraseError('STORAGE_FAILED', { cause: new Error('sqlite locked') })
    })
    registerPhraseIpc(service as never, registerTrustedHandler)
    const stored = registeredHandler(PHRASE_CHANNELS.list)({ sender: new FakeSender() }, {})
    expect(stored).toEqual({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    expect(JSON.stringify(stored)).not.toContain('sqlite')

    service.deleteByPhrase.mockImplementation(() => {
      throw new Error('DELETE FROM phrase WHERE phrase = ? at /Users/x/secret.sqlite')
    })
    const unknown = registeredHandler(PHRASE_CHANNELS.delete)(
      { sender: new FakeSender() },
      { phrase: ENTRY.phrase }
    )
    expect(unknown).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
    expect(JSON.stringify(unknown)).not.toContain('sqlite')
  })

  it('reports a safe error when the result violates the protocol', () => {
    const service = fakeService()
    service.list.mockReturnValue({ entries: [{ ...ENTRY, phrase: 42 }] } as unknown as PhrasePage)
    registerPhraseIpc(service as never, registerTrustedHandler)
    expect(registeredHandler(PHRASE_CHANNELS.list)({ sender: new FakeSender() }, {})).toEqual({
      status: 'error',
      error: { code: 'UNKNOWN_ERROR' }
    })

    service.deleteByPhrase.mockReturnValue({ phrase: ENTRY.phrase } as never)
    expect(
      registeredHandler(PHRASE_CHANNELS.delete)(
        { sender: new FakeSender() },
        { phrase: ENTRY.phrase }
      )
    ).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
  })

  it('unregisters both handlers via the returned cleanup', () => {
    const cleanup = registerPhraseIpc(fakeService() as never, registerTrustedHandler)
    expect(electronMocks.handle).toHaveBeenCalledTimes(2)
    expect(electronMocks.removeHandler).not.toHaveBeenCalled()
    cleanup()
    expect(electronMocks.removeHandler).toHaveBeenCalledWith(PHRASE_CHANNELS.list)
    expect(electronMocks.removeHandler).toHaveBeenCalledWith(PHRASE_CHANNELS.delete)
  })

  it('maps storage failures exhaustively', () => {
    expect(toSafePhraseManagementError(new PhraseError('STORAGE_FAILED'))).toEqual({
      code: 'STORAGE_FAILED'
    })
    expect(toSafePhraseManagementError(new PhraseError('INVALID_INPUT'))).toEqual({
      code: 'UNKNOWN_ERROR'
    })
    expect(toSafePhraseManagementError(new Error('boom'))).toEqual({ code: 'UNKNOWN_ERROR' })
    expect(toSafePhraseManagementError('str')).toEqual({ code: 'UNKNOWN_ERROR' })
  })
})
