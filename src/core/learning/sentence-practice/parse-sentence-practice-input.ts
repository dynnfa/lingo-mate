import type { SentencePracticeErrorCode } from '../../../shared/sentence-practice'

export class SentencePracticeError extends Error {
  constructor(
    readonly code: SentencePracticeErrorCode,
    options?: ErrorOptions
  ) {
    super(`Sentence practice failed: ${code}`, options)
    this.name = 'SentencePracticeError'
  }
}
