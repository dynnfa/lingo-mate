import { randomUUID } from 'node:crypto'
import type { SupportedLocale } from '../../../shared/preferences'
import {
  vocabularyAnalysisSchema,
  type AddVocabularyBatchInput,
  type VocabularyBatch,
  type VocabularyItemResult,
  type VocabularyErrorCode
} from '../../../shared/vocabulary'
import { parseVocabularyInput, VocabularyError } from './parse-vocabulary-input'
import type { StoredVocabulary, VocabularyRepository } from './vocabulary-repository'
import type { VocabularyAnalyzer } from './vocabulary-analyzer'
import { abortableOperation } from './abortable-operation'

interface Execution {
  controller: AbortController
  committing: boolean
  cancelled: boolean
  timer?: ReturnType<typeof setTimeout>
}
export class VocabularyModule {
  private readonly active = new Map<string, Execution>()
  private disposed = false
  // The module owns the word timeout policy and hands it to the analyzer factory,
  // so the adapter and the orchestration layer can never drift apart on the value.
  constructor(
    private readonly repository: VocabularyRepository,
    private readonly createAnalyzer: (wordMs: number) => VocabularyAnalyzer,
    private readonly timeouts = { wordMs: 30_000, batchMs: 120_000 }
  ) {}
  cancel(requestId: string): 'cancelled' | 'too_late' {
    const execution = this.active.get(requestId)
    if (!execution || execution.committing) return 'too_late'
    execution.cancelled = true
    clearTimeout(execution.timer)
    execution.controller.abort(new VocabularyError('CANCELLED'))
    return 'cancelled'
  }
  dispose(): void {
    this.disposed = true
    for (const requestId of this.active.keys()) this.cancel(requestId)
    this.active.clear()
  }
  async addBatch(
    input: AddVocabularyBatchInput,
    explanationLanguage: SupportedLocale
  ): Promise<VocabularyBatch> {
    if (this.disposed) throw new VocabularyError('CANCELLED')
    if (this.active.has(input.requestId)) throw new VocabularyError('BUSY')
    const items = parseVocabularyInput(input.text)
    const execution: Execution = {
      controller: new AbortController(),
      committing: false,
      cancelled: false
    }
    this.active.set(input.requestId, execution)
    const timer = setTimeout(
      () => execution.controller.abort(new VocabularyError('TIMEOUT')),
      this.timeouts.batchMs
    )
    execution.timer = timer
    const results: VocabularyItemResult[] = items.map((item) =>
      item.sourceInputIndex !== undefined
        ? {
            inputIndex: item.inputIndex,
            term: item.term,
            status: 'duplicate',
            sourceInputIndex: item.sourceInputIndex
          }
        : { inputIndex: item.inputIndex, term: item.term, status: 'failed', code: 'TIMEOUT' }
    )
    const pending: Array<{ inputIndex: number; entry: StoredVocabulary }> = []
    const fail = (index: number, code: VocabularyErrorCode): void => {
      results[index] = { inputIndex: index, term: items[index].term, status: 'failed', code }
    }
    try {
      const newItems = items.filter((item) => {
        if (item.sourceInputIndex !== undefined) return false
        const existing = this.repository.find(input.wordLanguage, item.lookupKey)
        if (!existing) return true
        results[item.inputIndex] = {
          inputIndex: item.inputIndex,
          term: item.term,
          status: 'existing',
          entryId: existing.id
        }
        return false
      })
      let analyzer: VocabularyAnalyzer | undefined
      let configurationError: VocabularyErrorCode | undefined
      if (newItems.length) {
        try {
          analyzer = this.createAnalyzer(this.timeouts.wordMs)
        } catch (cause) {
          configurationError = cause instanceof VocabularyError ? cause.code : 'MODEL_ERROR'
        }
      }
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < newItems.length && !execution.controller.signal.aborted) {
          const item = newItems[next++]
          try {
            if (!analyzer) throw new VocabularyError(configurationError ?? 'MODEL_ERROR')
            const result = await abortableOperation(
              execution.controller.signal,
              this.timeouts.wordMs,
              (signal) =>
                analyzer.analyze({
                  term: item.term,
                  wordLanguage: input.wordLanguage,
                  explanationLanguage,
                  signal
                })
            )
            if (execution.controller.signal.aborted) break
            if (result.status === 'unrecognized') throw new VocabularyError('UNRECOGNIZED')
            const parsed = vocabularyAnalysisSchema.safeParse(result.analysis)
            if (!parsed.success) throw new VocabularyError('INVALID_ANALYSIS')
            const now = new Date().toISOString()
            pending.push({
              inputIndex: item.inputIndex,
              entry: {
                id: randomUUID(),
                term: item.term,
                lookupKey: item.lookupKey,
                wordLanguage: input.wordLanguage,
                explanationLanguage,
                analysis: parsed.data,
                analysisSource: 'llm',
                analysisSchemaVersion: 1,
                modelId: result.modelId,
                promptVersion: result.promptVersion,
                createdAt: now,
                updatedAt: now
              }
            })
          } catch (cause) {
            fail(item.inputIndex, cause instanceof VocabularyError ? cause.code : 'MODEL_ERROR')
          }
        }
      }
      await Promise.all([worker(), worker()])
      if (execution.cancelled) {
        for (const item of items)
          if (results[item.inputIndex].status !== 'existing' && item.sourceInputIndex === undefined)
            fail(item.inputIndex, 'CANCELLED')
      } else if (pending.length) {
        // There is deliberately no await between this cancellation check and commit.
        execution.committing = true
        try {
          const saved = this.repository.saveBatch(pending.map((item) => item.entry))
          pending.forEach((item, index) => {
            results[item.inputIndex] = {
              inputIndex: item.inputIndex,
              term: item.entry.term,
              status: saved[index].status,
              entryId: saved[index].id
            }
          })
        } catch {
          for (const item of pending) fail(item.inputIndex, 'STORAGE_FAILED')
        }
      }
      const counts = { total: results.length, saved: 0, existing: 0, duplicate: 0, failed: 0 }
      let resolved = 0
      for (const result of results) {
        counts[result.status]++
        const source = result.status === 'duplicate' ? results[result.sourceInputIndex] : result
        if (source.status === 'saved' || source.status === 'existing') resolved++
      }
      return {
        requestId: input.requestId,
        explanationLanguage,
        items: results,
        counts,
        outcome: execution.cancelled
          ? 'cancelled'
          : resolved === results.length
            ? 'completed'
            : resolved
              ? 'partial'
              : 'failed'
      }
    } finally {
      clearTimeout(timer)
      execution.controller.abort()
      this.active.delete(input.requestId)
    }
  }
}
