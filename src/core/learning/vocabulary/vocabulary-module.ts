import type { SupportedLocale } from '../../../shared/preferences'
import type { AddVocabularyBatchInput, VocabularyBatch } from '../../../shared/vocabulary'
import type { VocabularyAgentRuntime } from '../../agent/agent-runtime'
import { VocabularyHostSession } from './vocabulary-host'
import type { VocabularyRepository } from './vocabulary-repository'
import type { VocabularyModelAnalyzer } from './vocabulary-analyzer'
import { VocabularyError } from './parse-vocabulary-input'

interface Execution {
  controller: AbortController
  committing: boolean
}
export interface VocabularyBatchOptions {
  executionId?: string
  signal?: AbortSignal
  onPhase?: (phase: 'analyzing' | 'committing') => void | Promise<void>
}

// Application adapter only. Agent scheduling and Prompt generation live in Python;
// the trusted host ledger owns validation and the single synchronous transaction.
export class VocabularyModule {
  private readonly active = new Map<string, Execution>()
  private disposed = false
  constructor(
    private readonly repository: VocabularyRepository,
    private readonly createAnalyzer: (wordMs: number) => VocabularyModelAnalyzer,
    private readonly runtime: VocabularyAgentRuntime,
    private readonly timeouts = { wordMs: 30_000, batchMs: 120_000 }
  ) {}
  cancel(requestId: string): 'cancelled' | 'too_late' {
    const execution = this.active.get(requestId)
    if (!execution || execution.committing) return 'too_late'
    execution.controller.abort(new VocabularyError('CANCELLED'))
    return 'cancelled'
  }
  dispose(): void {
    this.disposed = true
    for (const id of this.active.keys()) this.cancel(id)
  }
  async addBatch(
    input: AddVocabularyBatchInput,
    explanationLanguage: SupportedLocale,
    options: VocabularyBatchOptions = {}
  ): Promise<VocabularyBatch> {
    if (this.disposed) throw new VocabularyError('CANCELLED')
    if (this.active.has(input.requestId)) throw new VocabularyError('BUSY')
    const host = new VocabularyHostSession(
      this.repository,
      this.createAnalyzer,
      input.text,
      input.wordLanguage,
      explanationLanguage,
      this.timeouts
    )
    const execution: Execution = { controller: new AbortController(), committing: false }
    this.active.set(input.requestId, execution)
    const cancel = (): void => {
      this.cancel(input.requestId)
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    try {
      await options.onPhase?.('analyzing')
      if (execution.controller.signal.aborted) return host.report(input.requestId, true)
      await this.runtime.runVocabulary(
        {
          outputLanguage: explanationLanguage,
          targetLanguage: input.wordLanguage,
          signal: execution.controller.signal
        },
        host
      )
      if (execution.controller.signal.aborted) return host.report(input.requestId, true)
      await options.onPhase?.('committing')
      if (execution.controller.signal.aborted) return host.report(input.requestId, true)
      // No await is allowed between the final cancellation check and transaction.
      execution.committing = true
      return host.commit(input.requestId, options.executionId)
    } catch (error) {
      if (execution.controller.signal.aborted) return host.report(input.requestId, true)
      throw error
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      execution.controller.abort()
      this.active.delete(input.requestId)
    }
  }
}
