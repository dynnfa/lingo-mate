import type { SpeechErrorCode, SpeechSettings } from '../../shared/speech'

export class SpeechError extends Error {
  constructor(
    readonly code: SpeechErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options)
    this.name = 'SpeechError'
  }
}
export interface HeadTtsTiming {
  words: string[]
  wtimes: number[]
  wdurations: number[]
}
export interface SpeechSegment extends HeadTtsTiming {
  audio: Uint8Array
}
export interface SpeechSynthesizer {
  synthesize(text: string, settings: SpeechSettings, signal: AbortSignal): Promise<SpeechSegment>
}
