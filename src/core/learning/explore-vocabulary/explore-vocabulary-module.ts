import type { SupportedLocale } from '../../../shared/preferences'
import {
  type ExploreVocabularyBatch,
  type ExploreVocabularyHistoryDocument,
  type ExploreVocabularyHistoryItem
} from '../../../shared/explore-vocabulary'
import type { ExploreVocabularyAgentRuntime } from '../../agent/agent-runtime'
import { ExploreVocabularyHostSession } from './explore-vocabulary-host'
import { createAbortableOperation } from '../abortable-operation'
import { ExploreVocabularyError } from './explore-vocabulary-error'
import type { ExploreVocabularyGenerator } from './explore-vocabulary-generator'
import type {
  CommitExploreVocabularyBatchInput,
  ExploreVocabularyHistoryStore
} from './explore-vocabulary-history-store'
import { ExploreSerialLock } from '../explore-serial-lock'

const abortableExploreOperation = createAbortableOperation(ExploreVocabularyError)

export interface ExploreVocabularyModuleOptions {
  executionId: string
  sessionId: string
  userMessageId: string
  wordLanguage: 'en'
  explanationLanguage: SupportedLocale
  signal?: AbortSignal
  onPhase?: (phase: 'analyzing' | 'committing') => void | Promise<void>
  isProtected?: (batch: ExploreVocabularyBatch) => boolean | Promise<boolean>
}

export type ExploreVocabularyRunResult =
  { outcome: 'completed'; batch: ExploreVocabularyBatch } | { outcome: 'cancelled' }

// Application adapter: serialize history access, delegate generation scheduling
// to Python, then commit verified host content. Storage settles before unlocking.
export class ExploreVocabularyModule {
  constructor(
    private readonly store: ExploreVocabularyHistoryStore,
    private readonly createGenerator: (requestMs: number) => ExploreVocabularyGenerator,
    private readonly runtime: ExploreVocabularyAgentRuntime,
    private readonly lock: ExploreSerialLock = new ExploreSerialLock(
      () => new ExploreVocabularyError('CANCELLED')
    ),
    private readonly timeouts = { requestMs: 60_000, totalMs: 180_000 }
  ) {}

  async findBatch(userMessageId: string): Promise<ExploreVocabularyBatch | undefined> {
    return this.store.findBatchByUserMessage(userMessageId)
  }

  async explore(options: ExploreVocabularyModuleOptions): Promise<ExploreVocabularyRunResult> {
    const signal = options.signal ?? new AbortController().signal
    try {
      return await this.lock.run(signal, async () => {
        // Only read/generate under the interruptible deadline. Once committing,
        // wait for the actual storage outcome before returning or releasing the lock.
        const prepared = await abortableExploreOperation(
          signal,
          this.timeouts.totalMs,
          (innerSignal) => this.prepareBatch(options, innerSignal)
        )
        if ('existing' in prepared) return { outcome: 'completed', batch: prepared.existing }
        await options.onPhase?.('committing')
        if (signal.aborted) throw new ExploreVocabularyError('CANCELLED')
        const batch = await this.store.commit(
          {
            executionId: options.executionId,
            sessionId: options.sessionId,
            userMessageId: options.userMessageId,
            committedAt: new Date().toISOString(),
            wordLanguage: options.wordLanguage,
            explanationLanguage: options.explanationLanguage,
            items: prepared.items
          } satisfies CommitExploreVocabularyBatchInput,
          {
            base: prepared.history,
            isProtected: options.isProtected,
            signal
          }
        )
        return { outcome: 'completed', batch }
      })
    } catch (error) {
      if (error instanceof ExploreVocabularyError && error.code === 'CANCELLED') {
        return { outcome: 'cancelled' }
      }
      throw error
    }
  }

  private async prepareBatch(
    options: ExploreVocabularyModuleOptions,
    signal: AbortSignal
  ): Promise<
    | { existing: ExploreVocabularyBatch }
    | {
        history: ExploreVocabularyHistoryDocument
        items: ExploreVocabularyHistoryItem[]
      }
  > {
    await options.onPhase?.('analyzing')
    const history = await this.store.read()
    // 幂等：同 executionId 或稳定 userMessageId 已提交过时直接返回完整结果，
    // 不调用模型、不追加批次。
    const existing = history.batches.find(
      (batch) =>
        batch.executionId === options.executionId || batch.userMessageId === options.userMessageId
    )
    if (existing) return { existing }

    const host = new ExploreVocabularyHostSession(
      history,
      this.createGenerator,
      options.wordLanguage,
      options.explanationLanguage,
      this.timeouts.requestMs
    )
    await this.runtime.runExploreVocabulary(
      {
        outputLanguage: options.explanationLanguage,
        targetLanguage: options.wordLanguage,
        signal
      },
      host
    )
    signal.throwIfAborted()
    return { history, items: host.completedItems() }
  }
}
