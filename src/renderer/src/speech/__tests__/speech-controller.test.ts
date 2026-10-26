import { describe, expect, it, vi } from 'vitest'
import { SpeechController } from '../speech-controller'
import { AudioPlayer, type SpeechAudioDevice } from '../audio-player'
import { SPEECH_IDENTITY, type SpeechApi } from '../../../../shared/speech'

describe('application speech coordination', () => {
  it.each(['resolve', 'reject'] as const)(
    'keeps a paused seek when a superseded resume unlock settles with %s',
    async (settlement) => {
      let outputTime = 5
      const unlock = vi.fn(async () => {})
      const start = vi.fn(() => ({ stop: () => {} }))
      const controller = new SpeechController(
        {
          synthesize: async ({ requestId, text }) => ({
            status: 'ok',
            result: {
              requestId,
              text,
              language: 'en',
              identity: SPEECH_IDENTITY.revision,
              settings: { voice: 'af_bella', speed: 1 },
              audio: new Uint8Array(46),
              durationSeconds: 2,
              words: [
                {
                  index: 0,
                  text,
                  charStart: 0,
                  charEnd: text.length,
                  startSeconds: 0,
                  endSeconds: 2
                }
              ]
            }
          }),
          cancel: async () => ({ status: 'ok' })
        },
        new AudioPlayer({
          unlock,
          decode: async () => ({ durationSeconds: 2, start }),
          currentTime: () => 5,
          now: () => 1000,
          getState: () => 'running',
          getOutputTimestamp: () => ({ contextTime: outputTime, performanceTime: 1000 }),
          close: async () => {}
        }),
        { request: () => 1, cancel: () => {} }
      )
      await controller.speak('example', 'Hello')
      controller.pause()
      let resolveUnlock!: () => void
      let rejectUnlock!: (error: Error) => void
      unlock.mockReturnValueOnce(
        new Promise<void>((resolve, reject) => {
          resolveUnlock = resolve
          rejectUnlock = reject
        })
      )
      const resuming = controller.resume()
      await controller.seek(1)
      if (settlement === 'resolve') resolveUnlock()
      else rejectUnlock(new Error('Superseded device unlock failed'))
      await resuming
      expect(controller.getPlaybackSnapshot()).toMatchObject({
        status: 'paused',
        positionSeconds: 1,
        isPlaying: false
      })
      expect(controller.getPlaybackSnapshot().error).toBeUndefined()
      expect(start).toHaveBeenCalledTimes(1)
      await controller.resume()
      expect(start).toHaveBeenCalledTimes(2)
      outputTime = 5.23
      expect(controller.getPlaybackSnapshot().isPlaying).toBe(true)
      expect(controller.getPlaybackSnapshot().positionSeconds).toBeCloseTo(1.2)
      controller.stop()
    }
  )

  it('revokes an older result when another source replaces synthesis', async () => {
    const calls: Array<(value: Awaited<ReturnType<SpeechApi['synthesize']>>) => void> = []
    const api = {
      synthesize: () =>
        new Promise<Awaited<ReturnType<SpeechApi['synthesize']>>>((resolve) => calls.push(resolve)),
      cancel: vi.fn(async () => ({ status: 'ok' as const }))
    }
    const device: SpeechAudioDevice = {
      unlock: async () => {},
      decode: vi.fn(),
      currentTime: () => 5,
      now: () => 1000,
      getState: () => 'running',
      getOutputTimestamp: () => ({ contextTime: 5, performanceTime: 1000 }),
      close: async () => {}
    }
    const controller = new SpeechController(
      api,
      new AudioPlayer(device),
      { request: () => 1, cancel: () => {} },
      () => 'a5c2281c-b5de-4f88-809e-04cab8af2c87'
    )
    const old = controller.speak('first', 'First')
    const current = controller.speak('second', 'Second')
    calls[0]({ status: 'error', error: { code: 'RUNTIME_FAILED' } })
    await old
    expect(controller.getPlaybackSnapshot()).toMatchObject({
      sourceId: 'second',
      status: 'synthesizing',
      currentWord: null
    })
    calls[1]({ status: 'error', error: { code: 'NOT_INSTALLED' } })
    await current
    expect(controller.getPlaybackSnapshot()).toMatchObject({
      sourceId: 'second',
      status: 'failed',
      error: 'NOT_INSTALLED'
    })
    expect(api.cancel).toHaveBeenCalledTimes(1)
  })
})
