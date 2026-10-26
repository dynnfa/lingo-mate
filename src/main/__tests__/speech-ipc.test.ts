import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSpeechIpc } from '../speech-ipc'
import { createTrustedHandlerRegistrar } from '../ipc-guard'
import { SPEECH_CHANNELS } from '../../shared/speech'
import type { SpeechHost } from '../speech/speech-host'
import type { SpeechAudio } from '../../shared/speech'
import { FakeSender, registeredHandler, RENDERER_URL, resetIpcMocks } from './helpers/ipc-test-env'

vi.mock('electron', async () => (await import('./helpers/ipc-test-env')).electronTestModule())
beforeEach(resetIpcMocks)
describe('speech IPC ownership', () => {
  it('guards saved-audio reads and rejects path-bearing requests before accessing storage', async () => {
    const loadConversationAudio = vi.fn()
    const host: SpeechHost = {
      synthesize: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      getRuntimeStatus: vi.fn(),
      installResources: vi.fn(),
      subscribe: () => () => {},
      dispose: vi.fn()
    }
    const dispose = registerSpeechIpc(
      host,
      createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL }),
      { loadConversationAudio }
    )
    const sender = new FakeSender()
    const input = {
      sessionId: 'a5c2281c-b5de-4f88-809e-04cab8af2c87',
      messageId: 'a5c2281c-b5de-4f88-809e-04cab8af2c88'
    }
    sender.owned = false
    expect(
      await registeredHandler(SPEECH_CHANNELS.loadConversationAudio)({ sender }, input)
    ).toMatchObject({ status: 'error', error: { code: 'UNTRUSTED_SOURCE' } })
    sender.owned = true
    expect(
      await registeredHandler(SPEECH_CHANNELS.loadConversationAudio)(
        { sender },
        { ...input, path: '/private/audio.wav' }
      )
    ).toMatchObject({ status: 'error', error: { code: 'INVALID_INPUT' } })
    expect(loadConversationAudio).not.toHaveBeenCalled()
    dispose()
  })
  it('rejects an untrusted source before accessing speech resources', async () => {
    const host = {
      synthesize: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      getRuntimeStatus: vi.fn(),
      installResources: vi.fn(),
      subscribe: () => () => {},
      dispose: vi.fn()
    }
    registerSpeechIpc(host, createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL }), {
      loadConversationAudio: vi.fn()
    })
    const sender = new FakeSender()
    sender.owned = false
    expect(await registeredHandler(SPEECH_CHANNELS.getSettings)({ sender }, undefined)).toEqual({
      status: 'error',
      error: { code: 'UNTRUSTED_SOURCE' }
    })
    expect(host.getSettings).not.toHaveBeenCalled()
  })
  it('rejects cross-window cancellation, cancels on destruction, and discards late results', async () => {
    let finish!: (result: SpeechAudio) => void
    let signal!: AbortSignal
    const host: SpeechHost = {
      synthesize: (_input, cancellation) => {
        signal = cancellation
        return new Promise((resolve) => {
          finish = resolve
        })
      },
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      getRuntimeStatus: vi.fn(),
      installResources: vi.fn(),
      subscribe: () => () => {},
      dispose: vi.fn()
    }
    const dispose = registerSpeechIpc(
      host,
      createTrustedHandlerRegistrar({ rendererUrl: RENDERER_URL }),
      { loadConversationAudio: vi.fn() }
    )
    const owner = new FakeSender()
    const foreign = new FakeSender()
    const requestId = 'a5c2281c-b5de-4f88-809e-04cab8af2c87'
    const pending = registeredHandler(SPEECH_CHANNELS.synthesize)(
      { sender: owner },
      { requestId, text: 'Hello', language: 'en' }
    )
    expect(
      await registeredHandler(SPEECH_CHANNELS.cancel)({ sender: foreign }, { requestId })
    ).toEqual({ status: 'error', error: { code: 'NOT_OWNER' } })
    expect(signal.aborted).toBe(false)
    expect(
      await registeredHandler(SPEECH_CHANNELS.synthesize)(
        { sender: owner },
        { requestId, text: 'Hello', language: 'en' }
      )
    ).toEqual({ status: 'error', error: { code: 'INVALID_INPUT' } })
    owner.destroy()
    expect(signal.aborted).toBe(true)
    finish(undefined as unknown as SpeechAudio)
    expect(await pending).toEqual({ status: 'error', error: { code: 'CANCELLED' } })
    dispose()
  })
})
