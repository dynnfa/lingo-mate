import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SynonymError } from '../../core/learning/synonym/parse-synonym-input'
import { SYNONYM_CHANNELS, type SynonymListResult } from '../../shared/synonym'
import { registerSynonymIpc, toSafeSynonymManagementError } from '../synonym-ipc'

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
  id: '22222222-2222-4222-8222-222222222222',
  word: 'adequate',
  meaning: 'acceptable',
  groupid: '11111111-1111-4111-8111-111111111111',
  distinction: 'minimum standard'
}
const GROUP = {
  id: ENTRY.groupid,
  meaning: 'acceptable',
  words: [ENTRY]
}
const CURSOR = '33333333-3333-4333-8333-333333333333'

function fakeService(overrides: Partial<{ list: (input: unknown) => unknown }> = {}): {
  list: ReturnType<typeof vi.fn>
} {
  return {
    list: vi.fn(overrides.list ?? (() => ({ groups: [GROUP], nextCursor: null })))
  }
}

beforeEach(() => {
  electronMocks.handle.mockReset()
  electronMocks.removeHandler.mockReset()
})

describe('synonym IPC', () => {
  it('rejects untrusted callers before touching the service', () => {
    const service = fakeService()
    registerSynonymIpc(service as never, RENDERER_URL)
    const list = registeredHandler(SYNONYM_CHANNELS.list)

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
    }
    expect(list({ sender: subFrame, senderFrame: { url: RENDERER_URL } }, {})).toEqual({
      status: 'error',
      error: { code: 'UNTRUSTED_SOURCE' }
    })
    expect(service.list).not.toHaveBeenCalled()
  })

  it('rejects inputs outside the predefined window', () => {
    const service = fakeService()
    registerSynonymIpc(service as never, RENDERER_URL)

    expect(
      registeredHandler(SYNONYM_CHANNELS.list)({ sender: new FakeSender() }, { cursor: 'x' })
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(
      registeredHandler(SYNONYM_CHANNELS.list)({ sender: new FakeSender() }, { limit: 5 })
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(
      registeredHandler(SYNONYM_CHANNELS.list)({ sender: new FakeSender() }, 'cursor')
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(service.list).not.toHaveBeenCalled()
  })

  it('returns the parsed page with a cursor for trusted callers', () => {
    const service = fakeService({ list: () => ({ groups: [GROUP], nextCursor: CURSOR }) })
    registerSynonymIpc(service as never, RENDERER_URL)

    expect(service.list).not.toHaveBeenCalled()
    const result = registeredHandler(SYNONYM_CHANNELS.list)(
      { sender: new FakeSender() },
      {}
    ) as SynonymListResult
    expect(result).toEqual({ status: 'ok', groups: [GROUP], nextCursor: CURSOR })
    expect(service.list).toHaveBeenCalledWith({})

    const withCursor = registeredHandler(SYNONYM_CHANNELS.list)(
      { sender: new FakeSender() },
      { cursor: CURSOR }
    ) as SynonymListResult
    expect(withCursor).toEqual({ status: 'ok', groups: [GROUP], nextCursor: CURSOR })
    expect(service.list).toHaveBeenLastCalledWith({ cursor: CURSOR })
  })

  it('maps core errors to safe codes without internals', () => {
    const service = fakeService()
    service.list.mockImplementation(() => {
      throw new SynonymError('STORAGE_FAILED', { cause: new Error('sqlite locked') })
    })
    registerSynonymIpc(service as never, RENDERER_URL)
    const stored = registeredHandler(SYNONYM_CHANNELS.list)({ sender: new FakeSender() }, {})
    expect(stored).toEqual({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    expect(JSON.stringify(stored)).not.toContain('sqlite')

    service.list.mockImplementation(() => {
      throw new Error('SELECT * FROM synonym at /Users/x/secret.sqlite')
    })
    const unknown = registeredHandler(SYNONYM_CHANNELS.list)({ sender: new FakeSender() }, {})
    expect(unknown).toEqual({ status: 'error', error: { code: 'UNKNOWN_ERROR' } })
    expect(JSON.stringify(unknown)).not.toContain('sqlite')
  })

  it('reports a safe error when the result violates the protocol', () => {
    const service = fakeService()
    service.list.mockReturnValue({ groups: [{ ...GROUP, words: [] }] } as never)
    registerSynonymIpc(service as never, RENDERER_URL)
    expect(registeredHandler(SYNONYM_CHANNELS.list)({ sender: new FakeSender() }, {})).toEqual({
      status: 'error',
      error: { code: 'UNKNOWN_ERROR' }
    })
  })

  it('unregisters the handler via the returned cleanup', () => {
    const cleanup = registerSynonymIpc(fakeService() as never, RENDERER_URL)
    expect(electronMocks.handle).toHaveBeenCalledTimes(1)
    expect(electronMocks.handle).toHaveBeenCalledWith(SYNONYM_CHANNELS.list, expect.any(Function))
    expect(electronMocks.removeHandler).not.toHaveBeenCalled()
    cleanup()
    expect(electronMocks.removeHandler).toHaveBeenCalledWith(SYNONYM_CHANNELS.list)
  })

  it('maps storage failures exhaustively', () => {
    expect(toSafeSynonymManagementError(new SynonymError('STORAGE_FAILED'))).toEqual({
      code: 'STORAGE_FAILED'
    })
    expect(toSafeSynonymManagementError(new SynonymError('SCAN_LIMIT'))).toEqual({
      code: 'UNKNOWN_ERROR'
    })
    expect(toSafeSynonymManagementError(new Error('boom'))).toEqual({ code: 'UNKNOWN_ERROR' })
    expect(toSafeSynonymManagementError('str')).toEqual({ code: 'UNKNOWN_ERROR' })
  })
})
