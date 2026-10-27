import type { SupportedLocale } from '../../../shared/preferences'
import {
  EXPLORE_PHRASE_ITEM_COUNT,
  type ExplorePhraseHistoryDocument,
  type ExplorePhraseHistoryItem
} from '../../../shared/explore-phrase'
import { AgentRuntimeError, type ExplorePhraseHostOperations } from '../../agent/agent-runtime'
import {
  explorePhraseModelArgsSchema,
  type ExplorePhraseModelArgs,
  type ExplorePhrasePrepared,
  type ExplorePhraseReceipt,
  type ExplorePhraseCompletion
} from '../../agent/agent-protocol'
import { explorePhraseTools, submitExploredPhrasesArgumentsSchema } from './explore-phrase-tools'
import { ExplorePhraseError } from './explore-phrase-error'
import {
  explorePhraseUserContent,
  type ExplorePhraseGenerator,
  type ExplorePhraseGenerateInput
} from './explore-phrase-generator'
import {
  explorePhraseExampleContainsPhrase,
  normalizeExplorePhrase
} from './normalize-explore-phrase'

// Run-local trusted content ledger. Python controls scheduling, receives counts
// and sizes only, and has no persistence capability.
export class ExplorePhraseHostSession implements ExplorePhraseHostOperations {
  private readonly excluded: Set<string>
  private readonly accepted: ExplorePhraseHistoryItem[] = []
  private readonly acceptedKeys = new Set<string>()
  private prepared = false
  private verified = false
  private attempts = 0
  private inFlight = false
  private generator?: ExplorePhraseGenerator

  constructor(
    history: ExplorePhraseHistoryDocument,
    private readonly createGenerator: (requestMs: number) => ExplorePhraseGenerator,
    private readonly wordLanguage: 'en',
    private readonly explanationLanguage: SupportedLocale,
    private readonly requestMs = 60_000
  ) {
    this.excluded = new Set(
      history.batches.flatMap((batch) => batch.items.map((item) => item.normalizedPhrase))
    )
  }

  prepare(): ExplorePhrasePrepared {
    if (this.prepared) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.prepared = true
    return { acceptedCount: 0, inputChars: this.inputChars() }
  }

  async model(
    raw: ExplorePhraseModelArgs,
    signal: AbortSignal,
    maxInputChars: number
  ): Promise<ExplorePhraseReceipt> {
    signal.throwIfAborted()
    const parsed = explorePhraseModelArgsSchema.safeParse(raw)
    if (!parsed.success)
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR', { cause: parsed.error })
    const { attempt, systemPrompt } = parsed.data
    if (
      !this.prepared ||
      this.verified ||
      this.inFlight ||
      attempt !== this.attempts + 1 ||
      this.accepted.length === EXPLORE_PHRASE_ITEM_COUNT
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
        if (!(error instanceof ExplorePhraseError) || error.code !== 'INVALID_ANALYSIS') throw error
        candidates = []
      }
      signal.throwIfAborted()
      for (const candidate of candidates) {
        if (this.accepted.length === EXPLORE_PHRASE_ITEM_COUNT) break
        const item = validateCandidate(candidate, this.excluded, this.acceptedKeys)
        if (item) {
          this.accepted.push(item)
          this.acceptedKeys.add(item.normalizedPhrase)
        }
      }
      return { attempt, acceptedCount: this.accepted.length, inputChars: this.inputChars() }
    } finally {
      this.inFlight = false
    }
  }

  verifyCompletion(result: ExplorePhraseCompletion): void {
    if (
      !this.prepared ||
      this.verified ||
      this.inFlight ||
      this.attempts === 0 ||
      result.attempts !== this.attempts ||
      result.acceptedCount !== this.accepted.length
    )
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    if (this.accepted.length !== EXPLORE_PHRASE_ITEM_COUNT) {
      if (this.attempts !== 3) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      throw new ExplorePhraseError('GENERATION_FAILED')
    }
    this.verified = true
  }

  completedItems(): ExplorePhraseHistoryItem[] {
    if (!this.verified) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    return structuredClone(this.accepted)
  }

  private requestData(): Omit<ExplorePhraseGenerateInput, 'systemPrompt' | 'signal'> {
    return {
      count: EXPLORE_PHRASE_ITEM_COUNT - this.accepted.length,
      wordLanguage: this.wordLanguage,
      explanationLanguage: this.explanationLanguage,
      excludedPhrases: [...this.excluded, ...this.acceptedKeys]
    }
  }

  private inputChars(): number {
    if (this.accepted.length === EXPLORE_PHRASE_ITEM_COUNT) return 0
    const size =
      explorePhraseUserContent(this.requestData()).length +
      JSON.stringify(explorePhraseTools()).length
    if (size > 65_536) throw new AgentRuntimeError('AGENT_LIMIT')
    return size
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
