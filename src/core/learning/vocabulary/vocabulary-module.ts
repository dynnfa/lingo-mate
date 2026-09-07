import { randomUUID } from 'node:crypto'
import type { SupportedLocale } from '../../../shared/preferences'
import type {
  AddVocabularyBatchInput,
  VocabularyBatch,
  VocabularyErrorCode,
  VocabularyItemResult,
  VocabularyItemErrorCode
} from '../../../shared/vocabulary'
import { parseVocabularyInput, VocabularyError } from './parse-vocabulary-input'
import { buildVocabularyInsertCommand, type VocabularyInsertCommand } from './vocabulary-insert'
import type { VocabularyRepository } from './vocabulary-repository'
import type { VocabularyAnalyzer } from './vocabulary-analyzer'
import { abortableOperation } from './abortable-operation'
import { VOCABULARY_PROMPT_VERSION } from '../../prompt/vocabulary-analysis'

interface Execution {
  controller: AbortController
  committing: boolean
  cancelled: boolean
  timer?: ReturnType<typeof setTimeout>
}

export interface VocabularyBatchOptions {
  executionId?: string
  signal?: AbortSignal
  onPhase?: (phase: 'analyzing' | 'committing') => void | Promise<void>
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
    explanationLanguage: SupportedLocale,
    options: VocabularyBatchOptions = {}
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
    const cancelFromSignal = (): void => {
      this.cancel(input.requestId)
    }
    options.signal?.addEventListener('abort', cancelFromSignal, { once: true })
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
    // 模型阶段只暂存已通过校验的写入命令；提交前取消直接丢弃，不接触数据库。
    const pending: Array<{ inputIndex: number; command: VocabularyInsertCommand }> = []
    const fail = (index: number, code: VocabularyItemErrorCode): void => {
      results[index] = { inputIndex: index, term: items[index].term, status: 'failed', code }
    }
    try {
      await options.onPhase?.('analyzing')
      const candidates = items.filter((item) => item.sourceInputIndex === undefined)
      const existingByLookupKey = this.repository.findExisting(
        candidates.map((item) => item.lookupKey)
      )
      const newItems = candidates.filter((item) => {
        const existing = existingByLookupKey.get(item.lookupKey)
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
            if (result.status !== 'insert') throw new VocabularyError('INVALID_ANALYSIS')
            pending.push({
              inputIndex: item.inputIndex,
              command: buildVocabularyInsertCommand(result.content, {
                id: randomUUID(),
                modelId: result.modelId,
                promptVersion: VOCABULARY_PROMPT_VERSION,
                createdAt: new Date().toISOString()
              })
            })
          } catch (cause) {
            // 工具调用能力缺失属于当前模型/接口的批次级配置错误；继续把它
            // 降级为单词失败会伪装成已完成批次，并对其余词重复发送必败请求。
            if (cause instanceof VocabularyError) {
              if (cause.code === 'TOOL_CALL_NOT_SUPPORTED') throw cause
              fail(item.inputIndex, cause.code)
            } else {
              fail(item.inputIndex, 'MODEL_ERROR')
            }
          }
        }
      }
      await Promise.all([worker(), worker()])
      if (execution.cancelled) {
        for (const item of items)
          if (results[item.inputIndex].status !== 'existing' && item.sourceInputIndex === undefined)
            fail(item.inputIndex, 'CANCELLED')
      } else {
        await options.onPhase?.('committing')
        if (execution.cancelled) {
          for (const item of pending) fail(item.inputIndex, 'CANCELLED')
          return createBatch(input.requestId, explanationLanguage, results, true)
        }
        // There is deliberately no await between this cancellation check and commit.
        execution.committing = true
        try {
          const finalize = (
            saved: Array<{ id: string; status: 'saved' | 'existing' }>
          ): VocabularyBatch => {
            pending.forEach((item, index) => {
              results[item.inputIndex] = {
                inputIndex: item.inputIndex,
                term: item.command.parameters.term,
                status: saved[index].status,
                entryId: saved[index].id
              }
            })
            return createBatch(input.requestId, explanationLanguage, results, false)
          }
          if (options.executionId) {
            return this.repository.saveBatchWithResult(
              options.executionId,
              pending.map((item) => item.command),
              finalize
            )
          }
          const saved = pending.length
            ? this.repository.saveBatch(pending.map((item) => item.command))
            : []
          finalize(saved)
        } catch (cause) {
          if (options.executionId) throw new VocabularyError('STORAGE_FAILED', { cause })
          for (const item of pending) fail(item.inputIndex, 'STORAGE_FAILED')
        }
      }
      return createBatch(input.requestId, explanationLanguage, results, execution.cancelled)
    } finally {
      options.signal?.removeEventListener('abort', cancelFromSignal)
      clearTimeout(timer)
      execution.controller.abort()
      this.active.delete(input.requestId)
    }
  }
}

function createBatch(
  requestId: string,
  explanationLanguage: SupportedLocale,
  results: VocabularyItemResult[],
  cancelled: boolean
): VocabularyBatch {
  const counts = { total: results.length, saved: 0, existing: 0, duplicate: 0, failed: 0 }
  let resolved = 0
  for (const result of results) {
    counts[result.status]++
    const source = result.status === 'duplicate' ? results[result.sourceInputIndex] : result
    if (source.status === 'saved' || source.status === 'existing') resolved++
  }
  return {
    requestId,
    explanationLanguage,
    items: results,
    counts,
    outcome: cancelled
      ? 'cancelled'
      : resolved === results.length
        ? 'completed'
        : resolved
          ? 'partial'
          : 'failed'
  }
}
