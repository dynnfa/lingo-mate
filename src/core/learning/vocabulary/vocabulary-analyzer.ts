import type { SupportedLocale } from '../../../shared/preferences'
import type { VocabularyAnalysis } from '../../../shared/vocabulary'
export { vocabularyAnalysisSchema } from '../../../shared/vocabulary'

export interface AnalyzeVocabularyInput {
  term: string
  wordLanguage: 'en'
  explanationLanguage: SupportedLocale
  signal: AbortSignal
}
export type VocabularyAnalysisResult =
  | {
      status: 'recognized'
      analysis: VocabularyAnalysis
      modelId: string
      promptVersion: 'vocabulary-v1'
    }
  | { status: 'unrecognized' }
export interface VocabularyAnalyzer {
  analyze(input: AnalyzeVocabularyInput): Promise<VocabularyAnalysisResult>
}
