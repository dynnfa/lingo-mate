import type {
  SentenceContent,
  SentenceEntry,
  SentencePage,
  SentenceReport,
  ListSentenceInput
} from '../../../shared/sentence'
import type { SupportedLocale, TargetLanguage } from '../../../shared/preferences'
export interface SentenceRepository {
  findExisting(sourceText: string, targetLanguage: TargetLanguage): SentenceEntry | undefined
  commit(
    executionId: string,
    requestId: string,
    language: SupportedLocale,
    content: SentenceContent
  ): SentenceReport
  list(input: ListSentenceInput): SentencePage
  delete(id: string): boolean
}
export class SentenceError extends Error {
  constructor(
    readonly code:
      'STORAGE_FAILED' | 'INVALID_ANALYSIS' | 'MODEL_NOT_CONFIGURED' | 'MODEL_ERROR' | 'TIMEOUT',
    options?: ErrorOptions
  ) {
    super(`Sentence operation failed: ${code}`, options)
  }
}
