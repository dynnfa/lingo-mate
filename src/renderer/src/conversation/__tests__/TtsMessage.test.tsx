// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import { afterEach, expect, it, vi } from 'vitest'
import { createI18n } from '../../i18n'
import { TtsMessage } from '../TtsMessage'
import { SpeechController } from '../../speech/speech-controller'
import { AudioPlayer } from '../../speech/audio-player'
import { SPEECH_IDENTITY } from '../../../../shared/speech'

afterEach(cleanup)
it('shows original text without autoplay and seeks the second repeated word without starting playback', async () => {
  const text = ' Hello,\nHello! '
  const words = [
    { index: 0, text: 'Hello', charStart: 1, charEnd: 6, startSeconds: 0.1, endSeconds: 0.5 },
    { index: 1, text: 'Hello', charStart: 8, charEnd: 13, startSeconds: 1.1, endSeconds: 1.5 }
  ]
  const start = vi.fn(() => ({ stop: () => {} }))
  const synthesize = vi.fn()
  const load = vi.fn(async () => ({
    status: 'ok' as const,
    result: {
      requestId: 'a5c2281c-b5de-4f88-809e-04cab8af2c87',
      text,
      language: 'en' as const,
      identity: SPEECH_IDENTITY.revision,
      settings: { voice: 'af_bella' as const, speed: 1 },
      audio: new Uint8Array(46),
      durationSeconds: 2,
      words
    }
  }))
  const controller = new SpeechController(
    { synthesize, cancel: vi.fn() },
    new AudioPlayer({
      unlock: async () => {},
      decode: async () => ({ durationSeconds: 2, start }),
      currentTime: () => 5,
      now: () => 1000,
      getState: () => 'running',
      getOutputTimestamp: () => ({ contextTime: 5, performanceTime: 1000 }),
      close: async () => {}
    }),
    { request: () => 1, cancel: () => {} }
  )
  const { container } = render(
    <I18nextProvider i18n={createI18n('en')}>
      <TtsMessage
        sessionId="session"
        messageId="message"
        text={text}
        speech={{ kind: 'tts', durationSeconds: 2, words }}
        controller={controller}
        loadAudio={load}
      />
    </I18nextProvider>
  )
  expect(load).not.toHaveBeenCalled()
  expect(container.querySelector('.tts-original')?.textContent).toBe(text)
  fireEvent.click(screen.getAllByRole('button', { name: 'Seek to Hello' })[1])
  await waitFor(() => expect(controller.getState().positionSeconds).toBe(1.1))
  expect(start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
  expect(start).toHaveBeenCalledWith(expect.any(Number), 1.1, expect.any(Function))
  expect(synthesize).not.toHaveBeenCalled()
  expect(screen.queryByRole('slider')).not.toBeInTheDocument()
})
