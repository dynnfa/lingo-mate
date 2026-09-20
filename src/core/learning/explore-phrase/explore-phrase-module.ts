import type { SupportedLocale } from '../../../shared/preferences'
import {
  EXPLORE_PHRASE_ITEM_COUNT,
  type ExplorePhraseBatch,
  type ExplorePhraseHistoryItem
} from '../../../shared/explore-phrase'
import { submitExploredPhrasesArgumentsSchema } from '../../tools/explore-phrase-tools'
import { createAbortableOperation } from '../abortable-operation'
import { ExplorePhraseError } from './explore-phrase-error'
import type { ExplorePhraseGenerator } from './explore-phrase-generator'
import type {
  CommitExplorePhraseBatchInput,
  ExplorePhraseHistoryStore
} from './explore-phrase-history-store'
import { ExplorePhraseSerialLock } from './explore-phrase-lock'
import {
  explorePhraseExampleContainsPhrase,
  normalizeExplorePhrase
} from './normalize-explore-phrase'

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

// /explore-phrase 编排：串行锁内读取历史 → 模型生成（含补足，最多 3 次请求）
// → 本地校验凑齐 10 项 → 提交前最后检查取消 → 幂等提交批次。凑不齐 10 项时
// 明确失败，不返回部分成功、不写历史、不淘汰旧批次。
export class ExplorePhraseModule {
  constructor(
    private readonly store: ExplorePhraseHistoryStore,
    private readonly createGenerator: (requestMs: number) => ExplorePhraseGenerator,
    private readonly lock: ExplorePhraseSerialLock = new ExplorePhraseSerialLock(),
    private readonly timeouts = { requestMs: 60_000, totalMs: 180_000 },
    private readonly maxAttempts = 3
  ) {}

  async findBatch(userMessageId: string): Promise<ExplorePhraseBatch | undefined> {
    return this.store.findBatchByUserMessage(userMessageId)
  }

  async explore(options: ExplorePhraseModuleOptions): Promise<ExplorePhraseRunResult> {
    const signal = options.signal ?? new AbortController().signal
    try {
      return await this.lock.run(signal, () =>
        abortableExploreOperation(signal, this.timeouts.totalMs, (innerSignal) =>
          this.runLocked(options, innerSignal)
        )
      )
    } catch (error) {
      if (error instanceof ExplorePhraseError && error.code === 'CANCELLED') {
        return { outcome: 'cancelled' }
      }
      throw error
    }
  }

  private async runLocked(
    options: ExplorePhraseModuleOptions,
    signal: AbortSignal
  ): Promise<ExplorePhraseRunResult> {
    await options.onPhase?.('analyzing')
    const history = await this.store.read()
    // 幂等：同 executionId 或稳定 userMessageId 已提交过时直接返回完整结果，
    // 不调用模型、不追加批次。
    const existing = history.batches.find(
      (batch) =>
        batch.executionId === options.executionId || batch.userMessageId === options.userMessageId
    )
    if (existing) return { outcome: 'completed', batch: existing }

    const excluded = new Set(
      history.batches.flatMap((batch) => batch.items.map((item) => item.normalizedPhrase))
    )
    const accepted: ExplorePhraseHistoryItem[] = []
    const acceptedKeys = new Set<string>()
    const generator = this.createGenerator(this.timeouts.requestMs)
    let attempts = 0
    while (accepted.length < EXPLORE_PHRASE_ITEM_COUNT) {
      if (attempts >= this.maxAttempts) throw new ExplorePhraseError('GENERATION_FAILED')
      attempts += 1
      const count = EXPLORE_PHRASE_ITEM_COUNT - accepted.length
      let candidates
      try {
        candidates = await generator.generate({
          count,
          wordLanguage: options.wordLanguage,
          explanationLanguage: options.explanationLanguage,
          excludedPhrases: [...excluded, ...acceptedKeys],
          signal
        })
      } catch (error) {
        // 协议错误或非法结构消耗一次尝试：不接受该响应内容，继续补足；
        // 通信类失败（超时、网络、配置）立即失败。
        if (error instanceof ExplorePhraseError && error.code === 'INVALID_ANALYSIS') continue
        throw error
      }
      // 结构合法但内容不合格的候选直接丢弃；缺额走补足流程。
      for (const candidate of candidates) {
        if (accepted.length >= EXPLORE_PHRASE_ITEM_COUNT) break
        const item = validateCandidate(candidate, excluded, acceptedKeys)
        if (!item) continue
        accepted.push(item)
        acceptedKeys.add(item.normalizedPhrase)
      }
    }

    await options.onPhase?.('committing')
    // 提交前最后检查取消信号；此后的原子替换即结果生效点。
    if (signal.aborted) throw new ExplorePhraseError('CANCELLED')
    const batch = await this.store.commit(
      {
        executionId: options.executionId,
        sessionId: options.sessionId,
        userMessageId: options.userMessageId,
        committedAt: new Date().toISOString(),
        wordLanguage: options.wordLanguage,
        explanationLanguage: options.explanationLanguage,
        items: accepted
      } satisfies CommitExplorePhraseBatchInput,
      { base: history, isProtected: options.isProtected }
    )
    return { outcome: 'completed', batch }
  }
}

// 候选的本地裁决：结构（复用工具参数 schema）、规范化去重（历史 + 本次已接受）
// 与例句包含完整短语（词边界、允许大小写差异）。
function validateCandidate(
  candidate: { phrase: unknown; explanation: unknown; example: unknown },
  excluded: Set<string>,
  acceptedKeys: Set<string>
): ExplorePhraseHistoryItem | undefined {
  const parsed = submitExploredPhrasesArgumentsSchema.shape.items.element.safeParse({
    phrase: candidate.phrase,
    explanation: candidate.explanation,
    example: candidate.example
  })
  if (!parsed.success) return undefined
  const { phrase, explanation, example } = parsed.data
  const normalizedPhrase = normalizeExplorePhrase(phrase)
  if (excluded.has(normalizedPhrase) || acceptedKeys.has(normalizedPhrase)) return undefined
  if (!explorePhraseExampleContainsPhrase(example, phrase)) return undefined
  return { phrase, normalizedPhrase, explanation, example }
}
