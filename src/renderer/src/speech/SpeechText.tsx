import { useEffect, useSyncExternalStore } from 'react'
import { getSpeechController } from './speech-controller'
import { SpeakButton, type SpeechSourceProps } from './SpeakButton'
import './speech.css'

export function SpeechText({
  text,
  sourceId,
  controller = getSpeechController()
}: SpeechSourceProps): React.JSX.Element {
  const word = useSyncExternalStore(controller.subscribe, () => {
    const state = controller.getState()
    return state.sourceId === sourceId && state.text === text ? state.currentWord : null
  })
  useEffect(() => () => controller.stopSource(sourceId), [controller, sourceId, text])
  return (
    <span className="speech-content">
      <span className="speech-text">
        {word ? (
          <>
            {text.slice(0, word.charStart)}
            <mark aria-current="true" className="speech-word">
              {text.slice(word.charStart, word.charEnd)}
            </mark>
            {text.slice(word.charEnd)}
          </>
        ) : (
          text
        )}
      </span>
      <SpeakButton text={text} sourceId={sourceId} controller={controller} />
    </span>
  )
}
