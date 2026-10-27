import { ModelConfigValidationError } from '../../llm/model-config'
import type { SupportedLocale } from '../../../shared/preferences'
import { phraseBatchSchema, type PhraseBatch, type PhraseItemResult } from '../../../shared/phrase'
import { AgentRuntimeError, type PhraseHostOperations } from '../../agent/agent-runtime'
import {
  phraseAnalysisReceiptSchema,
  type PhraseAnalysisReceipt,
  type PhraseCompletion,
  type PhrasePrepared
} from '../../agent/agent-protocol'
import { parsePhraseInput, PhraseError } from './parse-phrase-input'
import { validatePhraseInsertArguments, type PhraseInsertContent } from './phrase-tools'
import type { PhraseRepository } from './phrase-repository'
import type { PhraseAnalyzer } from './phrase-analyzer'
import { abortablePhraseOperation } from './abortable-operation'

// A run-scoped trusted ledger. Python receives indices and safe receipts only;
// validated content, database identities and system metadata stay here.
export class PhraseHostSession implements PhraseHostOperations {
  private readonly items: ReturnType<typeof parsePhraseInput>
  private readonly results: PhraseItemResult[]
  private readonly pending = new Map<number, PhraseInsertContent>()
  private readonly claimed = new Set<number>()
  private readonly completed = new Set<number>()
  private prepared = false
  private verified = false
  private committed = false
  private deadline = 0
  private analyzer?: PhraseAnalyzer
  private configurationError?: unknown
  private resolved = false

  constructor(
    private readonly repository: PhraseRepository,
    private readonly createAnalyzer: (phraseMs: number) => PhraseAnalyzer,
    text: string,
    private readonly wordLanguage: 'en',
    private readonly explanationLanguage: SupportedLocale,
    private readonly timeouts = { phraseMs: 30_000, batchMs: 120_000 }
  ) {
    this.items = parsePhraseInput(text)
    this.results = this.items.map((item) =>
      item.sourceInputIndex === undefined
        ? {
            inputIndex: item.inputIndex,
            input: item.input,
            phrase: item.phrase,
            status: 'failed',
            code: 'TIMEOUT'
          }
        : {
            inputIndex: item.inputIndex,
            phrase: item.phrase,
            input: item.input,
            status: 'duplicate',
            sourceInputIndex: item.sourceInputIndex
          }
    )
  }

  prepare(): PhrasePrepared {
    if (this.prepared) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.prepared = true
    this.deadline = performance.now() + this.timeouts.batchMs
    const candidates = this.items.filter((item) => item.sourceInputIndex === undefined)
    const existing = this.repository.findExisting(candidates.map((item) => item.phrase))
    return {
      items: this.items.map((item) => {
        const base = { inputIndex: item.inputIndex, phrase: item.phrase }
        if (item.sourceInputIndex !== undefined)
          return { ...base, status: 'duplicate', sourceInputIndex: item.sourceInputIndex }
        const found = existing.get(item.phrase)
        if (found) {
          this.results[item.inputIndex] = { ...base, status: 'existing', input: item.input }
          return { ...base, status: 'existing' }
        }
        return { ...base, status: 'pending' }
      })
    }
  }

  async analyze(
    args: { inputIndex: number; systemPrompt: string },
    signal: AbortSignal
  ): Promise<PhraseAnalysisReceipt> {
    signal.throwIfAborted()
    const { inputIndex, systemPrompt } = args
    const item = this.items[inputIndex]
    if (
      !this.prepared ||
      this.verified ||
      !item ||
      item.sourceInputIndex !== undefined ||
      this.results[inputIndex].status === 'existing' ||
      this.claimed.has(inputIndex)
    )
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.claimed.add(inputIndex)
    let receipt: PhraseAnalysisReceipt
    try {
      const remaining = this.deadline - performance.now()
      if (remaining <= 0) throw new PhraseError('TIMEOUT')
      if (!this.resolved) {
        this.resolved = true
        try {
          this.analyzer = this.createAnalyzer(this.timeouts.phraseMs)
        } catch (error) {
          this.configurationError = error
        }
      }
      const analyzer = this.analyzer
      if (!analyzer) throw this.configurationError ?? new PhraseError('MODEL_ERROR')
      const result = await abortablePhraseOperation(
        signal,
        Math.min(this.timeouts.phraseMs, remaining),
        (childSignal) =>
          analyzer.analyze({
            phrase: item.phrase,
            wordLanguage: this.wordLanguage,
            explanationLanguage: this.explanationLanguage,
            systemPrompt,
            signal: childSignal
          })
      )
      signal.throwIfAborted()
      if (result.status === 'unrecognized') throw new PhraseError('UNRECOGNIZED')
      const content = validatePhraseInsertArguments(result.content, item.phrase)
      this.pending.set(inputIndex, content)
      receipt = { inputIndex, status: 'staged' }
    } catch (cause) {
      signal.throwIfAborted()
      if (
        cause instanceof AgentRuntimeError ||
        (cause instanceof ModelConfigValidationError &&
          cause.code === 'CREDENTIAL_DECRYPT_FAILED') ||
        (cause instanceof PhraseError && cause.code === 'TOOL_CALL_NOT_SUPPORTED')
      )
        throw cause
      const code = cause instanceof PhraseError ? cause.code : 'MODEL_ERROR'
      const parsed = phraseAnalysisReceiptSchema.safeParse({
        inputIndex,
        status: 'failed',
        code
      })
      if (!parsed.success || parsed.data.status !== 'failed') throw cause
      receipt = parsed.data
      this.results[inputIndex] = {
        inputIndex,
        phrase: item.phrase,
        input: item.input,
        status: 'failed',
        code: parsed.data.code
      }
    }
    this.completed.add(inputIndex)
    return receipt
  }

  verifyCompletion(result: PhraseCompletion): void {
    const expected = this.items
      .filter(
        (item) =>
          item.sourceInputIndex === undefined && this.results[item.inputIndex].status !== 'existing'
      )
      .map((item) => item.inputIndex)
    if (
      !this.prepared ||
      this.verified ||
      result.completedIndices.length !== expected.length ||
      new Set(result.completedIndices).size !== expected.length ||
      expected.some(
        (index) => !this.completed.has(index) || !result.completedIndices.includes(index)
      )
    )
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.verified = true
  }

  commit(requestId: string, executionId: string): PhraseBatch {
    if (!this.verified || this.committed) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.committed = true
    const pending = [...this.pending].sort(([a], [b]) => a - b)
    try {
      return this.repository.saveBatchWithResult(
        executionId,
        pending.map(([, content]) => content),
        (saved) => {
          pending.forEach(([index], i) => {
            this.results[index] = {
              inputIndex: index,
              input: this.items[index].input,
              phrase: this.items[index].phrase,
              status: saved[i]
            }
          })
          return this.report(requestId)
        }
      )
    } catch (cause) {
      throw new PhraseError('STORAGE_FAILED', { cause })
    }
  }

  report(requestId: string, cancelled = false): PhraseBatch {
    const items = structuredClone(this.results)
    if (cancelled) for (const item of items) if (item.status === 'failed') item.code = 'CANCELLED'
    const counts = { total: items.length, saved: 0, existing: 0, duplicate: 0, failed: 0 }
    let resolved = 0
    for (const item of items) {
      counts[item.status]++
      const source = item.status === 'duplicate' ? items[item.sourceInputIndex] : item
      if (source.status === 'saved' || source.status === 'existing') resolved++
    }
    return phraseBatchSchema.parse({
      requestId,
      explanationLanguage: this.explanationLanguage,
      items,
      counts,
      outcome: cancelled
        ? 'cancelled'
        : resolved === items.length
          ? 'completed'
          : resolved
            ? 'partial'
            : 'failed'
    })
  }
}
