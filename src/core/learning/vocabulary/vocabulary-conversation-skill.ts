import type { SupportedLocale } from '../../../shared/preferences'
import type { ConversationSkillReport } from '../../../shared/conversation'
import { isVocabularyBatch } from '../../../shared/vocabulary'
import { VocabularyModule } from './vocabulary-module'
import type { VocabularyAgentRuntime } from '../../agent/agent-runtime'
import type { VocabularyModelAnalyzer } from './vocabulary-analyzer'
import type { VocabularyRepository } from './vocabulary-repository'
import type { VocabularyFeedbackFormatter } from './vocabulary-feedback'
import type {
  ConversationSkill,
  ConversationSkillRunInput,
  ConversationSkillRunResult
} from '../../conversation/conversation-skill'

export interface VocabularySkillRuntime {
  analyzer: VocabularyModelAnalyzer
}

export class VocabularyConversationSkill implements ConversationSkill {
  readonly skillId = 'vocabulary' as const

  constructor(
    private readonly repository: VocabularyRepository,
    private readonly createRuntime: () => VocabularySkillRuntime,
    private readonly formatFeedback: VocabularyFeedbackFormatter,
    private readonly runtime: VocabularyAgentRuntime
  ) {}

  async run(input: ConversationSkillRunInput): Promise<ConversationSkillRunResult> {
    // 文本技能参数：由 ConversationModule 按 skillId 分派保证带 text 分支。
    if (!('text' in input.arguments)) throw new Error('Vocabulary skill requires text arguments')
    // The whole batch shares this immutable runtime/configuration snapshot.
    const module = new VocabularyModule(
      this.repository,
      () => this.createRuntime().analyzer,
      this.runtime
    )
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
