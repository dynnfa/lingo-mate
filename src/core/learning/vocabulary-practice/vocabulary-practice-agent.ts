import type { VocabularyPracticeAgentRuntime } from '../../agent/agent-runtime'
import type {
  VocabularyPracticeModel,
  VocabularyPracticeReviewer
} from './vocabulary-practice-reviewer'
import { VocabularyPracticeHost } from './vocabulary-practice-host'

export class AgentVocabularyPracticeReviewer implements VocabularyPracticeReviewer {
  constructor(
    private readonly runtime: VocabularyPracticeAgentRuntime,
    private readonly model: VocabularyPracticeModel
  ) {}

  async review(
    input: Parameters<VocabularyPracticeReviewer['review']>[0]
  ): ReturnType<VocabularyPracticeReviewer['review']> {
    input.signal.throwIfAborted()
    const host = new VocabularyPracticeHost(input.entries, this.model, input.signal)
    try {
      await this.runtime.runVocabularyPractice(
        { outputLanguage: input.explanationLanguage, targetLanguage: 'en', signal: input.signal },
        host
      )
      input.signal.throwIfAborted()
      return host.result()
    } finally {
      host.close()
    }
  }
}
