import { randomUUID } from 'node:crypto'
import { ModelConfigValidationError } from '../../llm/model-config'
import type { SupportedLocale } from '../../../shared/preferences'
import {
  vocabularyBatchSchema,
  type VocabularyBatch,
  type VocabularyItemResult
} from '../../../shared/vocabulary'
import { AgentRuntimeError, type VocabularyHostOperations } from '../../agent/agent-runtime'
import {
  vocabularyAnalysisReceiptSchema,
  type VocabularyAnalysisReceipt,
  type VocabularyCompletion,
  type VocabularyPrepared
} from '../../agent/agent-protocol'
import { parseVocabularyInput, VocabularyError } from './parse-vocabulary-input'
import {
  buildVocabularyInsertCommand,
  validateInsertArguments,
  type VocabularyInsertCommand
} from './vocabulary-insert'
import type { VocabularyRepository } from './vocabulary-repository'
import { VOCABULARY_PROMPT_VERSION, type VocabularyModelAnalyzer } from './vocabulary-analyzer'
import { abortableOperation } from './abortable-operation'

// A run-scoped trusted ledger. Python receives indices and safe receipts only;
// validated content, database identities and system metadata stay here.
export class VocabularyHostSession implements VocabularyHostOperations {
  private readonly items: ReturnType<typeof parseVocabularyInput>
  private readonly results: VocabularyItemResult[]
  private readonly pending = new Map<number, VocabularyInsertCommand>()
  private readonly claimed = new Set<number>()
  private readonly completed = new Set<number>()
  private prepared = false
  private verified = false
  private committed = false
  private deadline = 0
  private analyzer?: VocabularyModelAnalyzer
  private configurationError?: unknown
  private resolved = false

  constructor(
    private readonly repository: VocabularyRepository,
    private readonly createAnalyzer: (wordMs: number) => VocabularyModelAnalyzer,
    text: string,
    private readonly wordLanguage: 'en',
    private readonly explanationLanguage: SupportedLocale,
    private readonly timeouts = { wordMs: 30_000, batchMs: 120_000 }
  ) {
    this.items = parseVocabularyInput(text)
    this.results = this.items.map((item) =>
      item.sourceInputIndex === undefined
        ? { inputIndex: item.inputIndex, term: item.term, status: 'failed', code: 'TIMEOUT' }
        : {
            inputIndex: item.inputIndex,
            term: item.term,
            status: 'duplicate',
            sourceInputIndex: item.sourceInputIndex
          }
    )
  }

  prepare(): VocabularyPrepared {
    if (this.prepared) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.prepared = true
    this.deadline = performance.now() + this.timeouts.batchMs
    const candidates = this.items.filter((item) => item.sourceInputIndex === undefined)
    const existing = this.repository.findExisting(candidates.map((item) => item.lookupKey))
    return {
      items: this.items.map((item) => {
        const base = { inputIndex: item.inputIndex, term: item.term }
        if (item.sourceInputIndex !== undefined)
          return { ...base, status: 'duplicate', sourceInputIndex: item.sourceInputIndex }
        const found = existing.get(item.lookupKey)
        if (found) {
          this.results[item.inputIndex] = { ...base, status: 'existing', entryId: found.id }
          return { ...base, status: 'existing' }
        }
        return { ...base, status: 'pending' }
      })
    }
  }

  async analyze(
    args: { inputIndex: number; systemPrompt: string },
    signal: AbortSignal
  ): Promise<VocabularyAnalysisReceipt> {
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
    let receipt: VocabularyAnalysisReceipt
    try {
      const remaining = this.deadline - performance.now()
      if (remaining <= 0) throw new VocabularyError('TIMEOUT')
      if (!this.resolved) {
        this.resolved = true
        try {
          this.analyzer = this.createAnalyzer(this.timeouts.wordMs)
        } catch (error) {
          this.configurationError = error
        }
      }
      const analyzer = this.analyzer
      if (!analyzer) throw this.configurationError ?? new VocabularyError('MODEL_ERROR')
      const result = await abortableOperation(
        signal,
        Math.min(this.timeouts.wordMs, remaining),
        (childSignal) =>
          analyzer.analyze({
            term: item.term,
            wordLanguage: this.wordLanguage,
            explanationLanguage: this.explanationLanguage,
            systemPrompt,
            signal: childSignal
          })
      )
      signal.throwIfAborted()
      if (result.status === 'unrecognized') throw new VocabularyError('UNRECOGNIZED')
      const content = validateInsertArguments(
        {
          term: result.content.term,
          phonetic: result.content.phonetic,
          meaning: result.content.meaning,
          concept: result.content.concept,
          example_sentences: result.content.exampleSentences
        },
        item.term
      )
      this.pending.set(
        inputIndex,
        buildVocabularyInsertCommand(content, {
          id: randomUUID(),
          modelId: result.modelId,
          promptVersion: VOCABULARY_PROMPT_VERSION,
          createdAt: new Date().toISOString()
        })
      )
      receipt = { inputIndex, status: 'staged' }
    } catch (cause) {
      signal.throwIfAborted()
      if (
        cause instanceof AgentRuntimeError ||
        (cause instanceof ModelConfigValidationError &&
          cause.code === 'CREDENTIAL_DECRYPT_FAILED') ||
        (cause instanceof VocabularyError && cause.code === 'TOOL_CALL_NOT_SUPPORTED')
      )
        throw cause
      const code = cause instanceof VocabularyError ? cause.code : 'MODEL_ERROR'
      const parsed = vocabularyAnalysisReceiptSchema.safeParse({
        inputIndex,
        status: 'failed',
        code
      })
      if (!parsed.success || parsed.data.status !== 'failed') throw cause
      receipt = parsed.data
      this.results[inputIndex] = {
        inputIndex,
        term: item.term,
        status: 'failed',
        code: parsed.data.code
      }
    }
    this.completed.add(inputIndex)
    return receipt
  }

  verifyCompletion(result: VocabularyCompletion): void {
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

  commit(requestId: string, executionId?: string): VocabularyBatch {
    if (!this.verified || this.committed) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.committed = true
    const pending = [...this.pending].sort(([a], [b]) => a - b)
    const finalize = (
      saved: Array<{ id: string; status: 'saved' | 'existing' }>
    ): VocabularyBatch => {
      pending.forEach(([index], i) => {
        this.results[index] = {
          inputIndex: index,
          term: this.items[index].term,
          status: saved[i].status,
          entryId: saved[i].id
        }
      })
      return this.report(requestId)
    }
    try {
      if (executionId)
        return this.repository.saveBatchWithResult(
          executionId,
          pending.map(([, command]) => command),
          finalize
        )
      return finalize(
        pending.length ? this.repository.saveBatch(pending.map(([, command]) => command)) : []
      )
    } catch (cause) {
      if (executionId) throw new VocabularyError('STORAGE_FAILED', { cause })
      for (const [index] of pending)
        this.results[index] = {
          inputIndex: index,
          term: this.items[index].term,
          status: 'failed',
          code: 'STORAGE_FAILED'
        }
      return this.report(requestId)
    }
  }

  report(requestId: string, cancelled = false): VocabularyBatch {
    const items = structuredClone(this.results)
    if (cancelled) for (const item of items) if (item.status === 'failed') item.code = 'CANCELLED'
    const counts = { total: items.length, saved: 0, existing: 0, duplicate: 0, failed: 0 }
    let resolved = 0
    for (const item of items) {
      counts[item.status]++
      const source = item.status === 'duplicate' ? items[item.sourceInputIndex] : item
      if (source.status === 'saved' || source.status === 'existing') resolved++
    }
    return vocabularyBatchSchema.parse({
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
