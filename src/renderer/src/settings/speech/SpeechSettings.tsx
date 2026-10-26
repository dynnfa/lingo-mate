import { useTranslation } from 'react-i18next'
import { SPEECH_VOICES, type SpeechSettings as Settings } from '../../../../shared/speech'
import { useSpeechSettings } from './useSpeechSettings'
import '../../speech/speech.css'

export function SpeechSettings({ active }: { active: boolean }): React.JSX.Element {
  const { t } = useTranslation('speech')
  const state = useSpeechSettings(active)
  return (
    <div className="speech-settings">
      <p>{t('description')}</p>
      {state.runtime ? (
        <>
          <p role="status">{t(`runtime.${state.runtime.phase}`)}</p>
          {state.runtime.phase === 'installing' ? (
            <>
              <progress
                aria-label={t('runtime.installing')}
                value={state.runtime.progress}
                max={1}
              />
              <button type="button" onClick={() => void state.cancelInstall()}>
                {t('cancelInstall')}
              </button>
            </>
          ) : state.runtime.phase === 'not-installed' || state.runtime.phase === 'failed' ? (
            <button type="button" disabled={state.pending} onClick={() => void state.install()}>
              {t('install')}
            </button>
          ) : null}
        </>
      ) : null}
      <fieldset disabled={!state.loaded || state.pending}>
        <label>
          {t('voice')}
          <select
            value={state.settings.voice}
            onChange={(event) =>
              state.setSettings({
                ...state.settings,
                voice: event.target.value as Settings['voice']
              })
            }
          >
            {SPEECH_VOICES.map((voice) => (
              <option key={voice} value={voice}>
                {t(`voices.${voice}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('speed')}
          <input
            type="range"
            min={0.75}
            max={1.5}
            step={0.05}
            value={state.settings.speed}
            onChange={(event) =>
              state.setSettings({ ...state.settings, speed: Number(event.target.value) })
            }
          />
        </label>
        <output>{t('speedValue', { speed: state.settings.speed })}</output>
        <button type="button" onClick={() => void state.save()}>
          {t('save')}
        </button>
      </fieldset>
      {state.error || state.runtime?.error ? (
        <p role="alert">{t(`errors.${state.error ?? state.runtime!.error!}`)}</p>
      ) : null}
      {state.saved ? <p role="status">{t('saved')}</p> : null}
    </div>
  )
}
