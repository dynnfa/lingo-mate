import type { SupportedLocale } from '../../../shared/preferences'
import type {
  AddPhraseBatchInput,
  PhraseBatch,
  PhraseErrorCode,
  PhraseItemResult,
  PhraseItemErrorCode
} from '../../../shared/phrase'
import { parsePhraseInput, PhraseError } from './parse-phrase-input'
import type { PhraseRepository, PhraseSaveStatus } from './phrase-repository'
import type { PhraseAnalyzer } from './phrase-analyzer'
import type { PhraseInsertContent } from '../../tools/phrase-tools'
import { abortablePhraseOperation } from './abortable-operation'

export interface PhraseBatchOptions {
  executionId: string
  signal?: AbortSignal
  onPhase?: (phase: 'analyzing' | 'committing') => void | Promise<void>
}

// /phrase 批次编排：分析阶段只暂存已通过校验的内容，不持有事务；
// 提交阶段在一个同步短事务内复查冲突、写入并保存报告。
export class PhraseModule {
  // 模块统一持有单项与批次超时策略；与 vocabulary 首版保持一致。
  constructor(
    private readonly repository: PhraseRepository,
    private readonly createAnalyzer: (phraseMs: number) => PhraseAnalyzer,
    private readonly timeouts = { phraseMs: 30_000, batchMs: 120_000 }
  ) {}
  async addBatch(
    input: AddPhraseBatchInput,
    explanationLanguage: SupportedLocale,
    options: PhraseBatchOptions
  ): Promise<PhraseBatch> {
    const items = parsePhraseInput(input.text)
    const controller = new AbortController()
    let committing = false
    let cancelled = false
    const cancelFromSignal = (): void => {
      if (committing) return
      cancelled = true
      controller.abort(new PhraseError('CANCELLED'))
    }
    options.signal?.addEventListener('abort', cancelFromSignal, { once: true })
    if (options.signal?.aborted) cancelFromSignal()
    const timer = setTimeout(
      () => controller.abort(new PhraseError('TIMEOUT')),
      this.timeouts.batchMs
    )
    const results: PhraseItemResult[] = items.map((item) =>
      item.sourceInputIndex !== undefined
        ? {
            inputIndex: item.inputIndex,
            input: item.input,
            phrase: item.phrase,
            status: 'duplicate',
            sourceInputIndex: item.sourceInputIndex
          }
        : {
            inputIndex: item.inputIndex,
            input: item.input,
            phrase: item.phrase,
            status: 'failed',
            code: 'TIMEOUT'
          }
    )
    // 模型阶段只暂存已通过校验的内容对象；提交前取消直接丢弃，不接触数据库。
    const pending: Array<{ inputIndex: number; content: PhraseInsertContent }> = []
    const fail = (index: number, code: PhraseItemErrorCode): void => {
      results[index] = {
        inputIndex: index,
        input: items[index].input,
        phrase: items[index].phrase,
        status: 'failed',
        code
      }
    }
    try {
      await options.onPhase?.('analyzing')
      const candidates = items.filter((item) => item.sourceInputIndex === undefined)
      const existingPhrases = this.repository.findExisting(candidates.map((item) => item.phrase))
      const newItems = candidates.filter((item) => {
        if (!existingPhrases.has(item.phrase)) return true
        results[item.inputIndex] = {
          inputIndex: item.inputIndex,
          input: item.input,
          phrase: item.phrase,
          status: 'existing'
        }
        return false
      })
      let analyzer: PhraseAnalyzer | undefined
      let configurationError: PhraseErrorCode | undefined
      if (newItems.length) {
        try {
          analyzer = this.createAnalyzer(this.timeouts.phraseMs)
        } catch (cause) {
          configurationError = cause instanceof PhraseError ? cause.code : 'MODEL_ERROR'
        }
      }
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < newItems.length && !controller.signal.aborted) {
          const item = newItems[next++]
          try {
            if (!analyzer) throw new PhraseError(configurationError ?? 'MODEL_ERROR')
            const result = await abortablePhraseOperation(
              controller.signal,
              this.timeouts.phraseMs,
              (signal) =>
                analyzer.analyze({
                  phrase: item.phrase,
                  wordLanguage: input.wordLanguage,
                  explanationLanguage,
                  signal
                })
            )
            if (controller.signal.aborted) break
            if (result.status === 'unrecognized') throw new PhraseError('UNRECOGNIZED')
            if (result.status !== 'insert') throw new PhraseError('INVALID_ANALYSIS')
            pending.push({ inputIndex: item.inputIndex, content: result.content })
          } catch (cause) {
            // 工具调用能力缺失属于批次级配置错误；继续降级为单项失败会对
            // 其余短语重复发送必败请求，并伪装成已完成的批次。
            if (cause instanceof PhraseError) {
              if (cause.code === 'TOOL_CALL_NOT_SUPPORTED') throw cause
              fail(item.inputIndex, cause.code)
            } else {
              fail(item.inputIndex, 'MODEL_ERROR')
            }
          }
        }
      }
      await Promise.all([worker(), worker()])
      if (cancelled) {
        for (const item of items)
          if (results[item.inputIndex].status !== 'existing' && item.sourceInputIndex === undefined)
            fail(item.inputIndex, 'CANCELLED')
      } else {
        await options.onPhase?.('committing')
        if (cancelled) {
          for (const item of pending) fail(item.inputIndex, 'CANCELLED')
          return createBatch(input.requestId, explanationLanguage, results, true)
        }
        // 取消检查与同步提交之间刻意不插入任何 await。
        committing = true
        try {
          const finalize = (saved: PhraseSaveStatus[]): PhraseBatch => {
            pending.forEach((item, index) => {
              results[item.inputIndex] = {
                inputIndex: item.inputIndex,
                input: items[item.inputIndex].input,
                // 条目身份是 phrase 文本本身；报告不携带仓储外的附加标识。
                phrase: item.content.phrase,
                status: saved[index]
              }
            })
            return createBatch(input.requestId, explanationLanguage, results, false)
          }
          return this.repository.saveBatchWithResult(
            options.executionId,
            pending.map((item) => item.content),
            finalize
          )
        } catch (cause) {
          throw new PhraseError('STORAGE_FAILED', { cause })
        }
      }
      return createBatch(input.requestId, explanationLanguage, results, cancelled)
    } finally {
      options.signal?.removeEventListener('abort', cancelFromSignal)
      clearTimeout(timer)
      controller.abort()
    }
  }
}

function createBatch(
  requestId: string,
  explanationLanguage: SupportedLocale,
  results: PhraseItemResult[],
  cancelled: boolean
): PhraseBatch {
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
