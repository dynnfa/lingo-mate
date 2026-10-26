import { useSyncExternalStore } from 'react'
import { getSpeechController, type SpeechController } from './speech-controller'

export function useSpeech(
  controller: SpeechController = getSpeechController()
): ReturnType<SpeechController['getState']> {
  return useSyncExternalStore(controller.subscribe, controller.getState)
}
