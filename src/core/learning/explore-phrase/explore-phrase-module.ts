import type { SupportedLocale } from '../../../shared/preferences'
import {
  type ExplorePhraseBatch,
  type ExplorePhraseHistoryDocument,
  type ExplorePhraseHistoryItem
} from '../../../shared/explore-phrase'
import type { ExplorePhraseAgentRuntime } from '../../agent/agent-runtime'
import { ExplorePhraseHostSession } from './explore-phrase-host'
import { createAbortableOperation } from '../abortable-operation'
import { ExplorePhraseError } from './explore-phrase-error'
import type { ExplorePhraseGenerator } from './explore-phrase-generator'
import type {
  CommitExplorePhraseBatchInput,
  ExplorePhraseHistoryStore
} from './explore-phrase-history-store'
import { ExplorePhraseSerialLock } from './explore-phrase-lock'

const abortableExploreOperation = createAbortableOperation(ExplorePhraseError)

export interface ExplorePhraseModuleOptions {
  executionId: string
  sessionId: string
  userMessageId: string
  wordLanguage: 'en'
  explanationLanguage: SupportedLocale
  signal?: AbortSignal
  onPhase?: (phase: 'analyzing' | 'committing') => void | Promise<void>
  isProtected?: (batch: ExplorePhraseBatch) => boolean | Promise<boolean>
}

export type ExplorePhraseRunResult =
  { outcome: 'completed'; batch: ExplorePhraseBatch } | { outcome: 'cancelled' }

// Application adapter: serialize history access, delegate generation scheduling
// to Python, then commit verified host content. Storage settles before unlocking.
export class ExplorePhraseModule {
  constructor(
    private readonly store: ExplorePhraseHistoryStore,
    private readonly createGenerator: (requestMs: number) => ExplorePhraseGenerator,
    private readonly runtime: ExplorePhraseAgentRuntime,
    private readonly lock: ExplorePhraseSerialLock = new ExplorePhraseSerialLock(),
    private readonly timeouts = { requestMs: 60_000, totalMs: 180_000 }
  ) {}

  async findBatch(userMessageId: string): Promise<ExplorePhraseBatch | undefined> {
    return this.store.findBatchByUserMessage(userMessageId)
  }

  async explore(options: ExplorePhraseModuleOptions): Promise<ExplorePhraseRunResult> {
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
        if (signal.aborted) throw new ExplorePhraseError('CANCELLED')
        const batch = await this.store.commit(
          {
            executionId: options.executionId,
            sessionId: options.sessionId,
            userMessageId: options.userMessageId,
            committedAt: new Date().toISOString(),
            wordLanguage: options.wordLanguage,
            explanationLanguage: options.explanationLanguage,
            items: prepared.items
          } satisfies CommitExplorePhraseBatchInput,
          {
            base: prepared.history,
            isProtected: options.isProtected,
            signal
          }
        )
        return { outcome: 'completed', batch }
      })
    } catch (error) {
      if (error instanceof ExplorePhraseError && error.code === 'CANCELLED') {
        return { outcome: 'cancelled' }
      }
      throw error
    }
  }

  private async prepareBatch(
    options: ExplorePhraseModuleOptions,
    signal: AbortSignal
  ): Promise<
    | { existing: ExplorePhraseBatch }
    | {
        history: ExplorePhraseHistoryDocument
        items: ExplorePhraseHistoryItem[]
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

    const host = new ExplorePhraseHostSession(
      history,
      this.createGenerator,
      options.wordLanguage,
      options.explanationLanguage,
      this.timeouts.requestMs
    )
    await this.runtime.runExplorePhrase(
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
