import type { SupportedLocale } from '../../../shared/preferences'
import type { ConversationSkillReport } from '../../../shared/conversation'
import { isVocabularyBatch } from '../../../shared/vocabulary'
import { VocabularyModule } from './vocabulary-module'
import type { VocabularyAnalyzer } from './vocabulary-analyzer'
import type { VocabularyRepository } from './vocabulary-repository'
import type { VocabularyFeedbackFormatter } from './vocabulary-feedback'
import type {
  ConversationSkill,
  ConversationSkillRunInput,
  ConversationSkillRunResult
} from '../../conversation/conversation-skill'

export interface VocabularySkillRuntime {
  analyzer: VocabularyAnalyzer
}

export class VocabularyConversationSkill implements ConversationSkill {
  readonly skillId = 'vocabulary' as const

  constructor(
    private readonly repository: VocabularyRepository,
    private readonly createRuntime: () => VocabularySkillRuntime,
    private readonly formatFeedback: VocabularyFeedbackFormatter
  ) {}

  async run(input: ConversationSkillRunInput): Promise<ConversationSkillRunResult> {
    // The whole batch shares this immutable runtime/configuration snapshot.
    const runtime = this.createRuntime()
    const module = new VocabularyModule(this.repository, () => runtime.analyzer)
    const batch = await module.addBatch(
      {
        requestId: input.requestId,
        text: input.arguments.text,
        wordLanguage: input.arguments.wordLanguage
      },
      input.explanationLanguage,
      {
        executionId: input.executionId,
        signal: input.signal,
        onPhase: input.onPhase
      }
    )
    if (batch.outcome === 'cancelled') return { outcome: 'cancelled' }
    // summarizing 阶段只整理本地结果，不再调用模型描述。
    await input.onPhase('summarizing')
    return { outcome: 'completed', report: batch }
  }

  feedback(report: ConversationSkillReport, language: SupportedLocale): string {
    if (!isVocabularyBatch(report)) throw new Error('Report does not match the vocabulary skill')
    return this.formatFeedback(report, language)
  }
}
