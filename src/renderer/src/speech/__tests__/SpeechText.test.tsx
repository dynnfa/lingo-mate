// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'
import { createI18n } from '../../i18n'
import { SpeechText } from '../SpeechText'
import { SpeechController } from '../speech-controller'
import { AudioPlayer } from '../audio-player'
import { SPEECH_IDENTITY } from '../../../../shared/speech'

afterEach(cleanup)
describe('spoken plain text', () => {
  it('preserves whitespace and punctuation and highlights only the matching source range', async () => {
    let outputTime = 5
    const text = ' hello, hello! '
    const controller = new SpeechController(
      {
        synthesize: async ({ requestId }) => ({
          status: 'ok',
          result: {
            requestId,
            text,
            language: 'en',
            identity: SPEECH_IDENTITY.revision,
            settings: { voice: 'af_bella', speed: 1 },
            audio: new Uint8Array(45),
            durationSeconds: 2,
            words: [
              {
                index: 0,
                text: 'hello',
                charStart: 1,
                charEnd: 6,
                startSeconds: 0.1,
                endSeconds: 0.4
              },
              {
                index: 1,
                text: 'hello',
                charStart: 8,
                charEnd: 13,
                startSeconds: 0.6,
                endSeconds: 1
              }
            ]
          }
        }),
        cancel: async () => ({ status: 'ok' })
      },
      new AudioPlayer({
        unlock: async () => {},
        decode: async () => ({ durationSeconds: 2, start: () => ({ stop: () => undefined }) }),
        currentTime: () => 5,
        getState: () => 'running',
        getOutputTimestamp: () => ({ contextTime: outputTime, performanceTime: 1000 }),
        now: () => 1000,
        close: async () => {}
      }),
      { request: () => 1, cancel: () => {} }
    )
    const { container, unmount } = render(
      <I18nextProvider i18n={createI18n('en')}>
        <SpeechText text={text} sourceId="example:1" controller={controller} />
      </I18nextProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud: hello, hello!' }))
    await waitFor(() => expect(controller.getPlaybackSnapshot().status).toBe('playing'))
    act(() => {
      outputTime = 5.73
      controller.refresh()
    })
    expect(container.querySelector('.speech-text')?.textContent).toBe(text)
    expect(container.querySelector('mark')?.textContent).toBe('hello')
    expect(controller.getPlaybackSnapshot().currentWord?.index).toBe(1)
    act(() => controller.pause())
    expect(controller.getPlaybackSnapshot().status).toBe('paused')
    unmount()
    expect(controller.getPlaybackSnapshot().currentWord).toBeNull()
  })
})
