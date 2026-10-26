import { Fragment, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConversationSpeech, SpeechApi } from '../../../shared/speech'
import { getSpeechController, type SpeechController } from '../speech/speech-controller'
import { useSpeech } from '../speech/useSpeech'
import '../speech/speech.css'

interface TtsMessageProps {
  sessionId: string
  messageId: string
  text: string
  speech: ConversationSpeech
  controller?: SpeechController
  loadAudio?: SpeechApi['loadConversationAudio']
}

export function TtsMessage({
  sessionId,
  messageId,
  text,
  speech,
  controller = getSpeechController(),
  loadAudio = (input) => window.api.speech.loadConversationAudio(input)
}: TtsMessageProps): React.JSX.Element {
  const { t } = useTranslation('speech')
  const sourceId = `tts:${messageId}`
  const state = useSpeech(controller)
  const active = state.sourceId === sourceId && state.text === text
  const playing = active && state.status === 'playing'
  const loading = active && state.status === 'loading'
  const load = (): ReturnType<SpeechApi['synthesize']> => loadAudio({ sessionId, messageId })
  useEffect(() => () => controller.stopSource(sourceId), [controller, sourceId])
  const seek = (seconds: number): void => {
    if (active && ['ready', 'playing', 'paused', 'completed'].includes(state.status))
      void controller.seek(seconds)
    else void controller.loadSaved(sourceId, text, load, seconds)
  }
  return (
    <section className="tts-message" aria-label={t('player')}>
      <div className="tts-controls">
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            if (playing) controller.pause()
            else void controller.playSaved(sourceId, text, load)
          }}
        >
          {t(
            playing
              ? 'pause'
              : active && state.status === 'completed'
                ? 'replay'
                : active && state.status === 'paused'
                  ? 'resume'
                  : 'play'
          )}
        </button>
        <button type="button" disabled={!active} onClick={controller.stop}>
          {t('stop')}
        </button>
        <span>
          {t('position', {
            position: (active ? state.positionSeconds : 0).toFixed(1),
            duration: speech.durationSeconds.toFixed(1)
          })}
        </span>
        {loading ? <span role="status">{t('playback.loading')}</span> : null}
        {active && state.error ? <span role="alert">{t(`errors.${state.error}`)}</span> : null}
      </div>
      <p className="tts-original" lang="en">
        {speech.words.map((word, index) => {
          const before = text.slice(speech.words[index - 1]?.charEnd ?? 0, word.charStart)
          const current = active && state.currentWord?.index === word.index
          return (
            <Fragment key={word.index}>
              {before}
              <button
                type="button"
                className={`tts-word${current ? ' speech-word' : ''}`}
                aria-current={current ? 'true' : undefined}
                aria-label={t('seekWord', { word: word.text })}
                onClick={() => seek(word.startSeconds)}
              >
                {text.slice(word.charStart, word.charEnd)}
              </button>
            </Fragment>
          )
        })}
        {text.slice(speech.words.at(-1)?.charEnd ?? 0)}
      </p>
    </section>
  )
}
