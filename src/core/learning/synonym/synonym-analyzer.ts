import type { SupportedLocale } from '../../../shared/preferences'
import type { SynonymToolExecutor } from '../../tools/synonym-tools'
export interface SynonymAnalyzer {
  analyze(input: {
    word: string
    explanationLanguage: SupportedLocale
    signal: AbortSignal
    executor: SynonymToolExecutor
  }): Promise<void>
}
