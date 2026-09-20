import type { VocabularyMistakesErrorCode } from '../../../shared/vocabulary-mistakes'

export class VocabularyMistakesError extends Error {
  constructor(
    readonly code: VocabularyMistakesErrorCode,
    options?: ErrorOptions
  ) {
    super(`Vocabulary mistakes failed: ${code}`, options)
    this.name = 'VocabularyMistakesError'
  }
}
