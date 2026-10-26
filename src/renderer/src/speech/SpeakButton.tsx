import { useTranslation } from 'react-i18next'
import { useSyncExternalStore } from 'react'
import { getSpeechController, type SpeechController } from './speech-controller'

export interface SpeechSourceProps {
  text: string
  sourceId: string
  controller?: SpeechController
}
export function SpeakButton({
  text,
  sourceId,
  controller = getSpeechController()
}: SpeechSourceProps): React.JSX.Element {
  const { t } = useTranslation('speech')
  const active = useSyncExternalStore(controller.subscribe, () => {
    const state = controller.getState()
    return (
      state.sourceId === sourceId &&
      state.text === text &&
      ['synthesizing', 'playing', 'paused'].includes(state.status)
    )
  })
  const error = useSyncExternalStore(controller.subscribe, () => {
    const state = controller.getState()
    return state.sourceId === sourceId && state.text === text ? state.error : undefined
  })
  const loading = useSyncExternalStore(controller.subscribe, () => {
    const state = controller.getState()
    return state.sourceId === sourceId && state.text === text && state.status === 'synthesizing'
  })
  const label = t(active ? 'stopSource' : 'speak', { text })
  return (
    <span className="speech-source-status">
      <button
        type="button"
        className="speak-button"
        aria-label={label}
        title={label}
        aria-pressed={active}
        onClick={() => {
          if (active) controller.stop()
          else void controller.speak(sourceId, text)
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {active ? (
            <path d="M6 6h12v12H6z" />
          ) : (
            <path d="M4 9h4l5-4v14l-5-4H4V9zm12-3a8 8 0 0 1 0 12v-3a4 4 0 0 0 0-6V6z" />
          )}
        </svg>
      </button>
      {loading ? <span role="status">{t('playback.synthesizing')}</span> : null}
      {error ? <span role="alert">{t(`errors.${error}`)}</span> : null}
    </span>
  )
}
