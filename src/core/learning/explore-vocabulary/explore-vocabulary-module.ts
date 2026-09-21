import type { SupportedLocale } from '../../../shared/preferences'
import {
  EXPLORE_VOCABULARY_ITEM_COUNT,
  type ExploreVocabularyBatch,
  type ExploreVocabularyHistoryDocument,
  type ExploreVocabularyHistoryItem
} from '../../../shared/explore-vocabulary'
import { submitExploredVocabularyArgumentsSchema } from '../../tools/explore-vocabulary-tools'
import { createAbortableOperation } from '../abortable-operation'
import { ExploreSerialLock } from '../explore-serial-lock'
import { ExploreVocabularyError } from './explore-vocabulary-error'
import type { ExploreVocabularyGenerator } from './explore-vocabulary-generator'
import type {
  CommitExploreVocabularyBatchInput,
  ExploreVocabularyHistoryStore
} from './explore-vocabulary-history-store'
import {
  exploreVocabularyExampleContainsTerm,
  isExploreVocabularyTermShape,
  normalizeExploreVocabularyTerm
} from './normalize-explore-vocabulary'

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

// /explore-vocabulary 编排：串行锁内读取历史 → 模型生成（含补足，最多 3 次
// 请求）→ 本地校验凑齐 10 项 → 提交前最后检查取消 → 幂等提交批次。凑不齐
// 10 项时明确失败，不返回部分成功、不写历史、不淘汰旧批次。
export class ExploreVocabularyModule {
  constructor(
    private readonly store: ExploreVocabularyHistoryStore,
    private readonly createGenerator: (requestMs: number) => ExploreVocabularyGenerator,
    // 词汇技能自己的串行锁实例：与 explore-phrase 的锁互不排队。
    private readonly lock: ExploreSerialLock = new ExploreSerialLock(
      () => new ExploreVocabularyError('CANCELLED')
    ),
    private readonly timeouts = { requestMs: 60_000, totalMs: 180_000 },
    private readonly maxAttempts = 3
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

    const excluded = new Set(
      history.batches.flatMap((batch) => batch.items.map((item) => item.normalizedTerm))
    )
    const accepted: ExploreVocabularyHistoryItem[] = []
    const acceptedKeys = new Set<string>()
    const generator = this.createGenerator(this.timeouts.requestMs)
    let attempts = 0
    while (accepted.length < EXPLORE_VOCABULARY_ITEM_COUNT) {
      if (attempts >= this.maxAttempts) throw new ExploreVocabularyError('GENERATION_FAILED')
      attempts += 1
      const count = EXPLORE_VOCABULARY_ITEM_COUNT - accepted.length
      let candidates
      try {
        candidates = await generator.generate({
          count,
          wordLanguage: options.wordLanguage,
          explanationLanguage: options.explanationLanguage,
          excludedTerms: [...excluded, ...acceptedKeys],
          signal
        })
      } catch (error) {
        // 协议错误或非法结构消耗一次尝试：不接受该响应内容，继续补足；
        // 通信类失败（超时、网络、配置）立即失败。
        if (error instanceof ExploreVocabularyError && error.code === 'INVALID_ANALYSIS') continue
        throw error
      }
      // 结构合法但内容不合格的候选直接丢弃；缺额走补足流程。
      for (const candidate of candidates) {
        if (accepted.length >= EXPLORE_VOCABULARY_ITEM_COUNT) break
        const item = validateCandidate(candidate, excluded, acceptedKeys)
        if (!item) continue
        accepted.push(item)
        acceptedKeys.add(item.normalizedTerm)
      }
    }

    return { history, items: accepted }
  }
}

// 候选的本地裁决：结构（复用工具参数 schema）、词形（NFKC 与撇号规范化后
// 必须是无空格单词）、规范化去重（历史 + 本次已接受）与例句包含完整词形
//（词边界、连字符/撇号视为词内字符、允许大小写差异）。
function validateCandidate(
  candidate: { term: unknown; explanation: unknown; example: unknown },
  excluded: Set<string>,
  acceptedKeys: Set<string>
): ExploreVocabularyHistoryItem | undefined {
  const parsed = submitExploredVocabularyArgumentsSchema.shape.items.element.safeParse({
    term: candidate.term,
    explanation: candidate.explanation,
    example: candidate.example
  })
  if (!parsed.success) return undefined
  const { term, explanation, example } = parsed.data
  const normalizedTerm = normalizeExploreVocabularyTerm(term)
  if (!isExploreVocabularyTermShape(normalizedTerm)) return undefined
  if (excluded.has(normalizedTerm) || acceptedKeys.has(normalizedTerm)) return undefined
  if (!exploreVocabularyExampleContainsTerm(example, term)) return undefined
  return { term, normalizedTerm, explanation, example }
}
