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
      promptVersion: string
    }
  | { status: 'unrecognized' }
export interface VocabularyAnalyzer {
  analyze(input: AnalyzeVocabularyInput): Promise<VocabularyAnalysisResult>
}

// Version metadata is pinned by the application; Prompt text is owned by Python.
export const VOCABULARY_PROMPT_VERSION = 'vocabulary-tools-v4'
export interface VocabularyModelAnalyzer {
  analyze(
    input: AnalyzeVocabularyInput & { systemPrompt: string }
  ): Promise<VocabularyAnalysisResult>
}
