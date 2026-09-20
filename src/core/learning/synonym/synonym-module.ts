import {
  synonymBatchSchema,
  synonymOutcome,
  type SynonymBatch,
  type SynonymItemResult
} from '../../../shared/synonym'
import type { ConversationSkillRunInput } from '../../conversation/conversation-skill'
import type { SynonymRepository } from './synonym-repository'
import type { SynonymAnalyzer } from './synonym-analyzer'
import { parseSynonymInput, SynonymError, type SynonymInputItem } from './parse-synonym-input'
import { SynonymToolExecutor } from '../../tools/synonym-tools'
import { abortableSynonymOperation } from './abortable-operation'
import { summarizeSynonymFailure } from './synonym-diagnostics'
import { noopCoreDiagnostics, type CoreDiagnostics } from '../../error-diagnostics'

export class SynonymModule {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly repository: SynonymRepository,
    private readonly createAnalyzer: (timeoutMs: number) => SynonymAnalyzer,
    private readonly wordMs = 60000,
    // 单词失败经诊断接口上报脱敏后的 cause 链；默认丢弃，Main 装配时注入。
    private readonly diagnostics: CoreDiagnostics = noopCoreDiagnostics
  ) {}
  async addBatch(input: ConversationSkillRunInput): Promise<SynonymBatch> {
    // 文本技能参数：由 ConversationModule 按 skillId 分派保证带 text 分支。
    if (!('text' in input.arguments)) throw new Error('Synonym skill requires text arguments')
    const items = parseSynonymInput(input.arguments.text)
    const previous = input.previousReport
      ? synonymBatchSchema.parse(input.previousReport)
      : undefined
    const results: SynonymItemResult[] = items.map((item) => {
      const prior = previous?.items[item.inputIndex]
      if (
        prior?.word === item.word &&
        (prior.status === 'saved' || prior.status === 'existing' || prior.status === 'unrecognized')
      )
        return prior
      return item.sourceInputIndex === undefined
        ? { inputIndex: item.inputIndex, input: item.input, word: item.word, status: 'cancelled' }
        : { ...item, status: 'duplicate', sourceInputIndex: item.sourceInputIndex }
    })
    // One Main-owned instance serializes scans and commits. Cancelling a queued batch
    // must not wait for another conversation's network request to finish.
    let started = false
    let cancelled = false
    let onAbort: () => void = () => {}
    const interrupted = new Promise<SynonymBatch>((resolve, reject) => {
      onAbort = () => {
        if (started) return
        cancelled = true
        const report: SynonymBatch = {
          requestId: input.requestId,
          explanationLanguage: input.explanationLanguage,
          finalized: true,
          items: results,
          outcome: synonymOutcome(results)
        }
        try {
          this.repository.saveReport(input.executionId, report)
          resolve(report)
        } catch (cause) {
          reject(cause)
        }
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
      if (input.signal.aborted) onAbort()
    })
    const task = this.queue.then(() => {
      if (cancelled) return interrupted
      started = true
      return this.run(input, items, results)
    })
    this.queue = task.catch(() => {})
    try {
      return await Promise.race([task, interrupted])
    } finally {
      input.signal.removeEventListener('abort', onAbort)
    }
  }
  private async run(
    input: ConversationSkillRunInput,
    items: SynonymInputItem[],
    results: SynonymItemResult[]
  ): Promise<SynonymBatch> {
    const report = (values = results): SynonymBatch => ({
      requestId: input.requestId,
      finalized: false,
      explanationLanguage: input.explanationLanguage,
      items: values,
      outcome: synonymOutcome(values)
    })
    this.repository.saveReport(input.executionId, report())
    if (input.signal.aborted) return report()
    await input.onPhase('analyzing')
    const existing = this.repository.findExisting(items.map((item) => item.word))
    for (const item of items) {
      if (results[item.inputIndex].status !== 'cancelled') continue
      const entry = existing.get(item.word)
      if (entry)
        results[item.inputIndex] = {
          inputIndex: item.inputIndex,
          input: item.input,
          word: item.word,
          status: 'existing',
          entry
        }
    }
    this.repository.saveReport(input.executionId, report())
    let analyzer: SynonymAnalyzer | undefined
    for (const item of items) {
      if (results[item.inputIndex].status !== 'cancelled') continue
      const base = { inputIndex: item.inputIndex, input: item.input, word: item.word }
      if (input.signal.aborted) break
      try {
        analyzer ??= this.createAnalyzer(this.wordMs)
        await abortableSynonymOperation(input.signal, this.wordMs, async (signal) => {
          const executor = new SynonymToolExecutor(
            item.word,
            this.repository,
            (content) => {
              if (signal.aborted) throw new SynonymError('CANCELLED')
              const saved = this.repository.saveWord(input.executionId, content, (value) => {
                const updated = [...results]
                updated[item.inputIndex] = { ...base, ...value }
                return report(updated)
              })
              // Only a committed transaction updates the in-memory report.
              results[item.inputIndex] = { ...base, ...saved }
              return saved
            },
            signal
          )
          await analyzer!.analyze({
            word: item.word,
            explanationLanguage: input.explanationLanguage,
            signal,
            executor
          })
          if (signal.aborted) throw new SynonymError('CANCELLED')
          if (!executor.completed) throw new SynonymError('INVALID_ANALYSIS')
          if (results[item.inputIndex].status === 'cancelled')
            results[item.inputIndex] = { ...base, status: 'unrecognized' }
        })
      } catch (cause) {
        // Never replace a committed result if cancellation arrives at the await boundary.
        if (
          results[item.inputIndex].status !== 'saved' &&
          results[item.inputIndex].status !== 'existing'
        ) {
          const code = cause instanceof SynonymError ? cause.code : 'MODEL_ERROR'
          if (code !== 'CANCELLED') {
            this.diagnostics.report({
              module: 'synonym',
              operation: 'word',
              code,
              message: 'synonym word analysis failed',
              context: { chain: summarizeSynonymFailure(cause) }
            })
          }
          results[item.inputIndex] =
            code === 'CANCELLED'
              ? { ...base, status: 'cancelled' }
              : { ...base, status: 'failed', code }
          if (code === 'TOOL_CALL_NOT_SUPPORTED') {
            for (const remaining of items.slice(item.inputIndex + 1)) {
              if (results[remaining.inputIndex].status === 'cancelled')
                results[remaining.inputIndex] = {
                  inputIndex: remaining.inputIndex,
                  input: remaining.input,
                  word: remaining.word,
                  status: 'failed',
                  code
                }
            }
            break
          }
        }
      }
      this.repository.saveReport(input.executionId, report())
    }
    const finalReport = { ...report(), finalized: true }
    this.repository.saveReport(input.executionId, finalReport)
    return finalReport
  }
}
