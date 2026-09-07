import type { SupportedLocale } from '../../../shared/preferences'
import type { VocabularyInsertContent } from './vocabulary-insert'

export interface AnalyzeVocabularyInput {
  term: string
  wordLanguage: 'en'
  explanationLanguage: SupportedLocale
  signal: AbortSignal
}
export type VocabularyAnalysisResult =
  | {
      status: 'insert'
      content: VocabularyInsertContent
      modelId: string
      promptVersion: 'vocabulary-sql-v1'
    }
  | { status: 'unrecognized' }
export interface VocabularyAnalyzer {
  analyze(input: AnalyzeVocabularyInput): Promise<VocabularyAnalysisResult>
}
