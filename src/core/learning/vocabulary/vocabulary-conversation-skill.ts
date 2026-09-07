import type { SupportedLocale } from '../../../shared/preferences'
import type { RunConversationSkillInput } from '../../../shared/conversation'
import type { VocabularyBatch } from '../../../shared/vocabulary'
import { VocabularyModule } from './vocabulary-module'
import type { VocabularyAnalyzer } from './vocabulary-analyzer'
import type { VocabularyRepository } from './vocabulary-repository'
import type { VocabularyFeedbackFormatter } from './vocabulary-feedback'

export interface VocabularySkillRuntime {
  analyzer: VocabularyAnalyzer
}

export interface RunVocabularyConversationSkillInput {
  requestId: string
  executionId: string
  arguments: RunConversationSkillInput['arguments']
  explanationLanguage: SupportedLocale
  signal: AbortSignal
  onPhase: (phase: 'analyzing' | 'committing' | 'summarizing') => void | Promise<void>
}

export class VocabularyConversationSkill {
  constructor(
    private readonly repository: VocabularyRepository,
    private readonly createRuntime: () => VocabularySkillRuntime,
    private readonly formatFeedback: VocabularyFeedbackFormatter
  ) {}

  async run(input: RunVocabularyConversationSkillInput): Promise<{ batch: VocabularyBatch }> {
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
    if (batch.outcome === 'cancelled') return { batch }
    // summarizing 阶段只整理本地结果，不再调用模型描述。
    await input.onPhase('summarizing')
    return { batch }
  }

  feedback(batch: VocabularyBatch, language: SupportedLocale): string {
    return this.formatFeedback(batch, language)
  }
}
