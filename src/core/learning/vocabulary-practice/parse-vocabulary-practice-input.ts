import type { VocabularyPracticeErrorCode } from '../../../shared/vocabulary-practice'

export class VocabularyPracticeError extends Error {
  constructor(
    readonly code: VocabularyPracticeErrorCode,
    options?: ErrorOptions
  ) {
    super(`Vocabulary practice failed: ${code}`, options)
    this.name = 'VocabularyPracticeError'
  }
}
