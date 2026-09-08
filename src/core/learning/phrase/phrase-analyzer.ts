import type { SupportedLocale } from '../../../shared/preferences'
import type { PhraseInsertContent } from '../../tools/phrase-tools'

export interface AnalyzePhraseInput {
  phrase: string
  wordLanguage: 'en'
  explanationLanguage: SupportedLocale
  signal: AbortSignal
}
export type PhraseAnalysisResult =
  | {
      status: 'insert'
      content: PhraseInsertContent
      modelId: string
      promptVersion: 'phrase-tools-v1'
    }
  | { status: 'unrecognized' }
export interface PhraseAnalyzer {
  analyze(input: AnalyzePhraseInput): Promise<PhraseAnalysisResult>
}
