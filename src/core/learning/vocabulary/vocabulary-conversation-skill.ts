import type { SupportedLocale } from '../../../shared/preferences'
import type { RunConversationSkillInput } from '../../../shared/conversation'
import type { VocabularyBatch } from '../../../shared/vocabulary'
import { VocabularyModule } from './vocabulary-module'
import type { VocabularyAnalyzer } from './vocabulary-analyzer'
import type { VocabularyRepository } from './vocabulary-repository'
import type { VocabularyResultDescriber } from './vocabulary-result-describer'

interface VocabularySkillRuntime {
  analyzer: VocabularyAnalyzer
  describer: VocabularyResultDescriber
}

export class VocabularyDescriptionError extends Error {
  constructor(
    readonly batch: VocabularyBatch,
    cause: unknown
  ) {
    super('Vocabulary result description failed', { cause })
    this.name = 'VocabularyDescriptionError'
  }
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
    private readonly createRuntime: () => VocabularySkillRuntime
  ) {}

  async run(input: RunVocabularyConversationSkillInput): Promise<{
    batch: VocabularyBatch
    description: string
  }> {
    // Both model calls share this immutable runtime/configuration snapshot.
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
    if (batch.outcome === 'cancelled') return { batch, description: '' }
    try {
      await input.onPhase('summarizing')
      const description = await runtime.describer.describe({
        batch,
        explanationLanguage: input.explanationLanguage,
        signal: input.signal
      })
      return { batch, description }
    } catch (cause) {
      throw new VocabularyDescriptionError(batch, cause)
    }
  }

  async describe(
    batch: VocabularyBatch,
    explanationLanguage: SupportedLocale,
    signal: AbortSignal,
    onPhase: () => void | Promise<void>
  ): Promise<string> {
    const runtime = this.createRuntime()
    await onPhase()
    return runtime.describer.describe({ batch, explanationLanguage, signal })
  }
}
