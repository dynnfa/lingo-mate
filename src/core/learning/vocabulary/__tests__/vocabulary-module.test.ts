import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VocabularyModule } from '../vocabulary-module'
import { VocabularyError } from '../parse-vocabulary-input'
import type { AnalyzeVocabularyInput, VocabularyAnalysisResult } from '../vocabulary-analyzer'
import { insertCommand, insertResult, memoryRepository } from './fixtures'
import { VOCABULARY_INSERT_SQL } from '../vocabulary-insert'

const input = (text: string): { requestId: string; text: string; wordLanguage: 'en' } => ({
  requestId: randomUUID(),
  text,
  wordLanguage: 'en' as const
})
afterEach(() => vi.useRealTimers())
describe('VocabularyModule', () => {
  it('deduplicates, skips existing entries, commits once, and preserves explanation language', async () => {
    const repository = memoryRepository()
    repository.commands.push(insertCommand('banana'))
    const analyze = vi.fn(async ({ term }: AnalyzeVocabularyInput) => insertResult(term))
    const save = vi.spyOn(repository, 'saveBatch')
    const factory = vi.fn(() => ({ analyze }))
    const module = new VocabularyModule(repository, factory)
    const result = await module.addBatch(input('apple，banana, apple, orange'), 'en')
    expect(result.outcome).toBe('completed')
    expect(result.counts).toEqual({ total: 4, saved: 2, existing: 1, duplicate: 1, failed: 0 })
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({ term: 'apple', wordLanguage: 'en', explanationLanguage: 'en' })
    )
    expect(save).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith(30_000)
    const again = await module.addBatch(input('apple, banana, orange'), 'zh-CN')
    expect(again.counts.existing).toBe(3)
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenCalledTimes(1)
  })
  it('stages validated insert commands with system fields and executes them at commit', async () => {
    const repository = memoryRepository()
    const analyze = vi.fn(async ({ term }: AnalyzeVocabularyInput) => ({
      ...insertResult(term),
      modelId: 'configured-model'
    }))
    const module = new VocabularyModule(repository, () => ({ analyze }))
    const batch = await module.addBatch(input('apple'), 'zh-CN')
    expect(batch.counts.saved).toBe(1)
    expect(repository.commands).toHaveLength(1)
    const command = repository.commands[0]
    expect(command.sql).toBe(VOCABULARY_INSERT_SQL)
    expect(command.parameters).toMatchObject({
      term: 'apple',
      phonetic: '/ˈæpəl/',
      model_id: 'configured-model',
      prompt_version: 'vocabulary-tools-v2'
    })
    expect(command.parameters.id).toBe(
      batch.items[0].status === 'saved' ? batch.items[0].entryId : undefined
    )
    expect(JSON.parse(command.parameters.example_sentences)).toEqual([
      'I ate an apple after lunch.'
    ])
    expect(analyze).toHaveBeenCalledTimes(1)
  })
  it('isolates failures and retries only when explicitly resubmitted', async () => {
    const repository = memoryRepository()
    const analyze = vi.fn(async ({ term }: AnalyzeVocabularyInput) =>
      term === 'bad' ? ({ status: 'unrecognized' } as const) : insertResult(term)
    )
    const module = new VocabularyModule(repository, () => ({ analyze }))
    const batch = await module.addBatch(input('apple,bad,bad'), 'zh-CN')
    expect(batch.outcome).toBe('partial')
    expect(batch.items[1]).toMatchObject({ status: 'failed', code: 'UNRECOGNIZED' })
    expect(batch.items[2]).toMatchObject({ status: 'duplicate', sourceInputIndex: 1 })
    const failed = await module.addBatch(input('bad,bad'), 'en')
    expect(failed.outcome).toBe('failed')
    expect(repository.commands).toHaveLength(1)
    analyze.mockImplementation(async ({ term }: AnalyzeVocabularyInput) => insertResult(term))
    expect((await module.addBatch(input('bad'), 'en')).counts.saved).toBe(1)
  })
  it('marks every pending entry storage_failed on a transaction failure', async () => {
    const repository = memoryRepository()
    repository.commands.push(insertCommand('existing'))
    vi.spyOn(repository, 'saveBatch').mockImplementation(() => {
      throw new Error('private database path')
    })
    const module = new VocabularyModule(repository, () => ({
      analyze: async ({ term }: AnalyzeVocabularyInput) => insertResult(term)
    }))
    const batch = await module.addBatch(input('apple,orange,existing'), 'en')
    expect(batch.counts).toMatchObject({ saved: 0, failed: 2, existing: 1 })
    expect(batch.items[0]).toMatchObject({ code: 'STORAGE_FAILED' })
    expect(repository.commands).toHaveLength(1)
  })
  it('cancels parsed and in-flight work, ignores late results, and limits concurrency to two', async () => {
    const repository = memoryRepository()
    repository.commands.push(insertCommand('existing'))
    const completions: Array<(value: VocabularyAnalysisResult) => void> = []
    const signals: AbortSignal[] = []
    const analyze = vi.fn(({ signal }: AnalyzeVocabularyInput) => {
      signals.push(signal)
      return new Promise<VocabularyAnalysisResult>((resolve) => completions.push(resolve))
    })
    const module = new VocabularyModule(repository, () => ({ analyze }))
    const request = input('apple,banana,orange,existing')
    const promise = module.addBatch(request, 'en')
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2))
    completions[0](insertResult('apple'))
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(3))
    expect(repository.commands).toHaveLength(1)
    expect(module.cancel(request.requestId)).toBe('cancelled')
    const batch = await promise
    expect(batch.outcome).toBe('cancelled')
    expect(batch.counts).toMatchObject({ saved: 0, existing: 1, failed: 3 })
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    completions.forEach((resolve) => resolve(insertResult()))
    await Promise.resolve()
    expect(repository.commands).toHaveLength(1)
    expect(module.cancel(request.requestId)).toBe('too_late')
  })
  it('aborts individual requests even when the analyzer never settles', async () => {
    vi.useFakeTimers()
    const repository = memoryRepository()
    const signals: AbortSignal[] = []
    const factory = vi.fn(() => ({
      analyze: ({ signal }: AnalyzeVocabularyInput) => {
        signals.push(signal)
        return new Promise<VocabularyAnalysisResult>(() => {})
      }
    }))
    const module = new VocabularyModule(repository, factory, { wordMs: 30, batchMs: 120 })
    const promise = module.addBatch(input('apple,banana,orange'), 'en')
    await vi.advanceTimersByTimeAsync(65)
    const batch = await promise
    expect(batch.items.every((item) => item.status === 'failed' && item.code === 'TIMEOUT')).toBe(
      true
    )
    expect(factory).toHaveBeenCalledWith(30)
    expect(signals).toHaveLength(3)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('batch deadline retains earlier valid results and marks unstarted entries timeout', async () => {
    vi.useFakeTimers()
    const repository = memoryRepository()
    const analyze = vi.fn(async ({ term }: AnalyzeVocabularyInput) =>
      term === 'apple' ? insertResult('apple') : new Promise<VocabularyAnalysisResult>(() => {})
    )
    const module = new VocabularyModule(repository, () => ({ analyze }), {
      wordMs: 100,
      batchMs: 20
    })
    const promise = module.addBatch(input('apple,banana,orange,pear'), 'en')
    await vi.advanceTimersByTimeAsync(21)
    const batch = await promise
    expect(batch.outcome).toBe('partial')
    expect(batch.counts).toMatchObject({ saved: 1, failed: 3 })
    expect(analyze).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('supports immediate cancellation, duplicate active IDs and shutdown without writes', async () => {
    const repository = memoryRepository()
    const analyze = vi.fn(async ({ term }: AnalyzeVocabularyInput) => insertResult(term))
    const module = new VocabularyModule(repository, () => ({ analyze }))
    const request = input('apple,banana,orange')
    const promise = module.addBatch(request, 'en')
    await expect(module.addBatch(request, 'en')).rejects.toThrow('BUSY')
    module.dispose()
    expect((await promise).outcome).toBe('cancelled')
    expect(repository.commands).toHaveLength(0)
    await expect(module.addBatch(input('apple'), 'en')).rejects.toThrow('CANCELLED')
  })
  it('rejects invalid tool results from the analyzer and handles missing config without fake data', async () => {
    const repository = memoryRepository()
    const module = new VocabularyModule(repository, () => ({
      analyze: async () => {
        throw new VocabularyError('INVALID_ANALYSIS')
      }
    }))
    expect((await module.addBatch(input('apple'), 'en')).items[0]).toMatchObject({
      code: 'INVALID_ANALYSIS'
    })
    const missing = new VocabularyModule(repository, () => {
      throw new VocabularyError('MODEL_NOT_CONFIGURED')
    })
    expect((await missing.addBatch(input('apple'), 'en')).items[0]).toMatchObject({
      code: 'MODEL_NOT_CONFIGURED'
    })
    expect(repository.commands).toHaveLength(0)
  })
  it('escalates tool capability errors without committing a failed batch', async () => {
    const repository = memoryRepository()
    const save = vi.spyOn(repository, 'saveBatch')
    const module = new VocabularyModule(repository, () => ({
      analyze: async () => {
        throw new VocabularyError('TOOL_CALL_NOT_SUPPORTED')
      }
    }))
    await expect(module.addBatch(input('apple'), 'en')).rejects.toMatchObject({
      code: 'TOOL_CALL_NOT_SUPPORTED'
    })
    expect(save).not.toHaveBeenCalled()
    expect(repository.commands).toHaveLength(0)
  })
  it('refuses cancellation once synchronous commit starts', async () => {
    const repository = memoryRepository()
    const module = new VocabularyModule(repository, () => ({
      analyze: async () => insertResult()
    }))
    const request = input('apple')
    const save = repository.saveBatch
    repository.saveBatch = (commands) => {
      expect(module.cancel(request.requestId)).toBe('too_late')
      return save(commands)
    }
    expect((await module.addBatch(request, 'en')).counts.saved).toBe(1)
  })
})
