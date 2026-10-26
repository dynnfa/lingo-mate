import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { getSpeechController } from './speech-controller'
import { useSpeech } from './useSpeech'
import './speech.css'

export function SpeechControls(): React.JSX.Element | null {
  const { t } = useTranslation('speech')
  const state = useSpeech()
  const controller = getSpeechController()
  useEffect(() => {
    document.addEventListener('visibilitychange', controller.refresh)
    return () => document.removeEventListener('visibilitychange', controller.refresh)
  }, [controller])
  if (state.status === 'idle' || state.status === 'cancelled') return null
  const controllable = state.status === 'playing' || state.status === 'paused'
  return (
    <section className="speech-controls" aria-label={t('player')}>
      <span role="status">{t(`playback.${state.status}`)}</span>
      {state.error ? <span role="alert">{t(`errors.${state.error}`)}</span> : null}
      {controllable ? (
        <>
          <button
            type="button"
            onClick={() => {
              if (state.status === 'paused') void controller.resume()
              else controller.pause()
            }}
          >
            {t(state.status === 'paused' ? 'resume' : 'pause')}
          </button>
          <input
            type="range"
            aria-label={t('seek')}
            min={0}
            max={state.durationSeconds}
            step={0.01}
            value={state.positionSeconds}
            onChange={(event) => void controller.seek(Number(event.target.value))}
          />
          <span>
            {t('position', {
              position: state.positionSeconds.toFixed(1),
              duration: state.durationSeconds.toFixed(1)
            })}
          </span>
        </>
      ) : null}
      <button type="button" onClick={controller.stop}>
        {t('stop')}
      </button>
    </section>
  )
}
