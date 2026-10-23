import type { SupportedLocale } from '../../../shared/preferences'
import {
  EXPLORE_VOCABULARY_ITEM_COUNT,
  type ExploreVocabularyHistoryDocument,
  type ExploreVocabularyHistoryItem
} from '../../../shared/explore-vocabulary'
import { AgentRuntimeError, type ExploreVocabularyHostOperations } from '../../agent/agent-runtime'
import {
  exploreVocabularyModelArgsSchema,
  type ExploreVocabularyModelArgs,
  type ExploreVocabularyPrepared,
  type ExploreVocabularyReceipt,
  type ExploreVocabularyCompletion
} from '../../agent/agent-protocol'
import {
  exploreVocabularyTools,
  submitExploredVocabularyArgumentsSchema
} from '../../tools/explore-vocabulary-tools'
import { ExploreVocabularyError } from './explore-vocabulary-error'
import {
  exploreVocabularyUserContent,
  type ExploreVocabularyGenerator,
  type ExploreVocabularyGenerateInput
} from './explore-vocabulary-generator'
import {
  exploreVocabularyExampleContainsTerm,
  normalizeExploreVocabularyTerm,
  isExploreVocabularyTermShape
} from './normalize-explore-vocabulary'

// Run-local trusted content ledger. Python controls scheduling, receives counts
// and sizes only, and has no persistence capability.
export class ExploreVocabularyHostSession implements ExploreVocabularyHostOperations {
  private readonly excluded: Set<string>
  private readonly accepted: ExploreVocabularyHistoryItem[] = []
  private readonly acceptedKeys = new Set<string>()
  private prepared = false
  private verified = false
  private attempts = 0
  private inFlight = false
  private generator?: ExploreVocabularyGenerator

  constructor(
    history: ExploreVocabularyHistoryDocument,
    private readonly createGenerator: (requestMs: number) => ExploreVocabularyGenerator,
    private readonly wordLanguage: 'en',
    private readonly explanationLanguage: SupportedLocale,
    private readonly requestMs = 60_000
  ) {
    this.excluded = new Set(
      history.batches.flatMap((batch) => batch.items.map((item) => item.normalizedTerm))
    )
  }

  prepare(): ExploreVocabularyPrepared {
    if (this.prepared) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.prepared = true
    return { acceptedCount: 0, inputChars: this.inputChars() }
  }

  async model(
    raw: ExploreVocabularyModelArgs,
    signal: AbortSignal,
    maxInputChars: number
  ): Promise<ExploreVocabularyReceipt> {
    signal.throwIfAborted()
    const parsed = exploreVocabularyModelArgsSchema.safeParse(raw)
    if (!parsed.success)
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR', { cause: parsed.error })
    const { attempt, systemPrompt } = parsed.data
    if (
      !this.prepared ||
      this.verified ||
      this.inFlight ||
      attempt !== this.attempts + 1 ||
      this.accepted.length === EXPLORE_VOCABULARY_ITEM_COUNT
    )
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    if (systemPrompt.length + this.inputChars() > maxInputChars)
      throw new AgentRuntimeError('AGENT_LIMIT')
    this.attempts = attempt
    this.inFlight = true
    try {
      this.generator ??= this.createGenerator(this.requestMs)
      let candidates
      try {
        candidates = await this.generator.generate({ ...this.requestData(), systemPrompt, signal })
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof ExploreVocabularyError) || error.code !== 'INVALID_ANALYSIS')
          throw error
        candidates = []
      }
      signal.throwIfAborted()
      for (const candidate of candidates) {
        if (this.accepted.length === EXPLORE_VOCABULARY_ITEM_COUNT) break
        const item = validateCandidate(candidate, this.excluded, this.acceptedKeys)
        if (item) {
          this.accepted.push(item)
          this.acceptedKeys.add(item.normalizedTerm)
        }
      }
      return { attempt, acceptedCount: this.accepted.length, inputChars: this.inputChars() }
    } finally {
      this.inFlight = false
    }
  }

  verifyCompletion(result: ExploreVocabularyCompletion): void {
    if (
      !this.prepared ||
      this.verified ||
      this.inFlight ||
      this.attempts === 0 ||
      result.attempts !== this.attempts ||
      result.acceptedCount !== this.accepted.length
    )
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    if (this.accepted.length !== EXPLORE_VOCABULARY_ITEM_COUNT) {
      if (this.attempts !== 3) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      throw new ExploreVocabularyError('GENERATION_FAILED')
    }
    this.verified = true
  }

  completedItems(): ExploreVocabularyHistoryItem[] {
    if (!this.verified) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    return structuredClone(this.accepted)
  }

  private requestData(): Omit<ExploreVocabularyGenerateInput, 'systemPrompt' | 'signal'> {
    return {
      count: EXPLORE_VOCABULARY_ITEM_COUNT - this.accepted.length,
      wordLanguage: this.wordLanguage,
      explanationLanguage: this.explanationLanguage,
      excludedTerms: [...this.excluded, ...this.acceptedKeys]
    }
  }

  private inputChars(): number {
    if (this.accepted.length === EXPLORE_VOCABULARY_ITEM_COUNT) return 0
    const size =
      exploreVocabularyUserContent(this.requestData()).length +
      JSON.stringify(exploreVocabularyTools()).length
    if (size > 65_536) throw new AgentRuntimeError('AGENT_LIMIT')
    return size
  }
}
// 候选的本地裁决：结构（复用工具参数 schema）、规范化去重（历史 + 本次已接受）
// 与词形及例句包含完整单词（词边界、允许大小写差异）。
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
