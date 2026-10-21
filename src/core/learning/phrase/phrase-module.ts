import type { SupportedLocale } from '../../../shared/preferences'
import type { AddPhraseBatchInput, PhraseBatch } from '../../../shared/phrase'
import type { PhraseAgentRuntime } from '../../agent/agent-runtime'
import { PhraseHostSession } from './phrase-host'
import type { PhraseRepository } from './phrase-repository'
import type { PhraseAnalyzer } from './phrase-analyzer'
import { PhraseError } from './parse-phrase-input'

export interface PhraseBatchOptions {
  executionId: string
  signal?: AbortSignal
  onPhase?: (phase: 'analyzing' | 'committing') => void | Promise<void>
}

// Application adapter only. Agent scheduling and Prompt generation live in Python;
// the trusted host ledger owns validation and the single synchronous transaction.
export class PhraseModule {
  constructor(
    private readonly repository: PhraseRepository,
    private readonly createAnalyzer: (phraseMs: number) => PhraseAnalyzer,
    private readonly runtime: PhraseAgentRuntime,
    private readonly timeouts = { phraseMs: 30_000, batchMs: 120_000 }
  ) {}
  async addBatch(
    input: AddPhraseBatchInput,
    explanationLanguage: SupportedLocale,
    options: PhraseBatchOptions
  ): Promise<PhraseBatch> {
    const host = new PhraseHostSession(
      this.repository,
      this.createAnalyzer,
      input.text,
      input.wordLanguage,
      explanationLanguage,
      this.timeouts
    )
    const controller = new AbortController()
    let committing = false
    const cancel = (): void => {
      if (!committing) controller.abort(new PhraseError('CANCELLED'))
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    try {
      await options.onPhase?.('analyzing')
      if (controller.signal.aborted) return host.report(input.requestId, true)
      await this.runtime.runPhrase(
        {
          outputLanguage: explanationLanguage,
          targetLanguage: input.wordLanguage,
          signal: controller.signal
        },
        host
      )
      if (controller.signal.aborted) return host.report(input.requestId, true)
      await options.onPhase?.('committing')
      if (controller.signal.aborted) return host.report(input.requestId, true)
      // No await is allowed between the final cancellation check and transaction.
      committing = true
      return host.commit(input.requestId, options.executionId)
    } catch (error) {
      if (controller.signal.aborted) return host.report(input.requestId, true)
      throw error
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      controller.abort()
    }
  }
}
