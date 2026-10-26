import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSpeechApi } from '../speech-api'

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: ipc }))
beforeEach(() => vi.clearAllMocks())
describe('speech preload boundary', () => {
  it('rejects arbitrary resource URLs and out-of-range speed before IPC', async () => {
    const api = createSpeechApi()
    await expect(api.updateSettings({ voice: 'af_bella', speed: 3 })).rejects.toThrow()
    await expect(
      api.updateSettings({ voice: 'af_bella', speed: 1, url: 'https://untrusted.invalid' } as never)
    ).rejects.toThrow()
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
  it('rejects unvalidated responses and filters status events to the minimal schema', async () => {
    ipc.invoke.mockResolvedValue({ status: 'ok', settings: { voice: 'af_bella', speed: 0.5 } })
    await expect(createSpeechApi().getSettings()).rejects.toThrow()
    const listener = vi.fn()
    const detach = createSpeechApi().onStatus(listener)
    const receive = ipc.on.mock.calls[0][1]
    receive({}, { phase: 'ready', progress: 1, path: '/private/model' })
    expect(listener).not.toHaveBeenCalled()
    receive({}, { phase: 'ready', progress: 1 })
    expect(listener).toHaveBeenCalledWith({ phase: 'ready', progress: 1 })
    detach()
    expect(ipc.removeListener).toHaveBeenCalled()
  })
})
