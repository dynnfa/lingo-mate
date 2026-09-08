import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhraseModule } from '../phrase-module'
import { PhraseError } from '../parse-phrase-input'
import type { AnalyzePhraseInput, PhraseAnalysisResult } from '../phrase-analyzer'
import { insertResult, content, memoryRepository } from './fixtures'

const input = (text: string): { requestId: string; text: string; wordLanguage: 'en' } => ({
  requestId: randomUUID(),
  text,
  wordLanguage: 'en' as const
})

afterEach(() => vi.useRealTimers())

describe('PhraseModule', () => {
  it('deduplicates by line, skips existing entries, commits once, and preserves language', async () => {
    const repository = memoryRepository()
    repository.contents.push(content('piece of cake'))
    const analyze = vi.fn(async ({ phrase }: AnalyzePhraseInput) => insertResult(phrase))
    const save = vi.spyOn(repository, 'saveBatchWithResult')
    const factory = vi.fn(() => ({ analyze }))
    const module = new PhraseModule(repository, factory)
    const result = await module.addBatch(
      input('look forward to\npiece of cake\nlook forward to\nbreak even'),
      'en',
      { executionId: randomUUID() }
    )
    expect(result.outcome).toBe('completed')
    expect(result.counts).toEqual({ total: 4, saved: 2, existing: 1, duplicate: 1, failed: 0 })
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        phrase: 'look forward to',
        wordLanguage: 'en',
        explanationLanguage: 'en'
      })
    )
    expect(save).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
    const again = await module.addBatch(input('look forward to\nbreak even'), 'zh-CN', {
      executionId: randomUUID()
    })
    expect(again.counts.existing).toBe(2)
    // 全部已存在时不请求模型
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenCalledTimes(1)
    // 大小写不同视为不同项：LOOK FORWARD TO 是新条目而非重复
    const cased = await module.addBatch(input('LOOK FORWARD TO'), 'en', {
      executionId: randomUUID()
    })
    expect(cased.counts).toEqual({ total: 1, saved: 1, existing: 0, duplicate: 0, failed: 0 })
    expect(analyze).toHaveBeenCalledTimes(3)
  })
  it('keeps the original input line and the normalized phrase in the report', async () => {
    const repository = memoryRepository()
    const module = new PhraseModule(repository, () => ({
      analyze: async ({ phrase }: AnalyzePhraseInput) => insertResult(phrase)
    }))
    const batch = await module.addBatch(input('look  forward to'), 'zh-CN', {
      executionId: randomUUID()
    })
    expect(batch.counts.saved).toBe(1)
    expect(batch.items[0]).toMatchObject({
      inputIndex: 0,
      input: 'look  forward to',
      phrase: 'look forward to',
      status: 'saved'
    })
    expect(repository.contents[0]).toMatchObject({
      phrase: 'look forward to',
      explantation: '期待，盼望（某件将发生的事）。',
      example: 'I look forward to hearing from you.'
    })
  })
  it('isolates failures and reports unrecognized items without writing them', async () => {
    const repository = memoryRepository()
    const analyze = vi.fn(async ({ phrase }: AnalyzePhraseInput) =>
      phrase === 'zzz qqq' ? ({ status: 'unrecognized' } as const) : insertResult(phrase)
    )
    const module = new PhraseModule(repository, () => ({ analyze }))
    const batch = await module.addBatch(input('look forward to\nzzz qqq\nzzz qqq'), 'zh-CN', {
      executionId: randomUUID()
    })
    expect(batch.outcome).toBe('partial')
    expect(batch.items[1]).toMatchObject({ status: 'failed', code: 'UNRECOGNIZED' })
    expect(batch.items[2]).toMatchObject({ status: 'duplicate', sourceInputIndex: 1 })
    expect(repository.contents).toHaveLength(1)
  })
  it('propagates transaction failure without reporting a completed batch', async () => {
    const repository = memoryRepository()
    vi.spyOn(repository, 'saveBatchWithResult').mockImplementation(() => {
      throw new PhraseError('STORAGE_FAILED')
    })
    const module = new PhraseModule(repository, () => ({
      analyze: async ({ phrase }: AnalyzePhraseInput) => insertResult(phrase)
    }))
    await expect(
      module.addBatch(input('look forward to\nbreak even'), 'en', { executionId: randomUUID() })
    ).rejects.toMatchObject({ code: 'STORAGE_FAILED' })
    expect(repository.contents).toHaveLength(0)
  })
  it('cancels in-flight work, ignores late results, and limits concurrency to two', async () => {
    const repository = memoryRepository()
    const completions: Array<(value: PhraseAnalysisResult) => void> = []
    const signals: AbortSignal[] = []
    const analyze = vi.fn(({ signal }: AnalyzePhraseInput) => {
      signals.push(signal)
      return new Promise<PhraseAnalysisResult>((resolve) => completions.push(resolve))
    })
    const module = new PhraseModule(repository, () => ({ analyze }))
    const request = input('look forward to\nbreak even\npiece of cake')
    const controller = new AbortController()
    const promise = module.addBatch(request, 'en', {
      executionId: randomUUID(),
      signal: controller.signal
    })
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2))
    completions[0](insertResult('look forward to'))
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(3))
    expect(repository.contents).toHaveLength(0)
    controller.abort()
    const batch = await promise
    expect(batch.outcome).toBe('cancelled')
    expect(batch.counts).toMatchObject({ saved: 0, failed: 3 })
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    completions.forEach((resolve) => resolve(insertResult()))
    await Promise.resolve()
    expect(repository.contents).toHaveLength(0)
  })
  it('aborts individual requests even when the analyzer never settles', async () => {
    vi.useFakeTimers()
    const repository = memoryRepository()
    const signals: AbortSignal[] = []
    const factory = vi.fn(() => ({
      analyze: ({ signal }: AnalyzePhraseInput) => {
        signals.push(signal)
        return new Promise<PhraseAnalysisResult>(() => {})
      }
    }))
    const module = new PhraseModule(repository, factory, { phraseMs: 30, batchMs: 120 })
    const promise = module.addBatch(input('a\nb\nc'), 'en', { executionId: randomUUID() })
    await vi.advanceTimersByTimeAsync(65)
    const batch = await promise
    expect(batch.items.every((item) => item.status === 'failed' && item.code === 'TIMEOUT')).toBe(
      true
    )
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('batch deadline retains earlier valid results and marks unstarted entries timeout', async () => {
    vi.useFakeTimers()
    const repository = memoryRepository()
    const analyze = vi.fn(async ({ phrase }: AnalyzePhraseInput) =>
      phrase === 'a' ? insertResult('a') : new Promise<PhraseAnalysisResult>(() => {})
    )
    const module = new PhraseModule(repository, () => ({ analyze }), {
      phraseMs: 100,
      batchMs: 20
    })
    const promise = module.addBatch(input('a\nb\nc\nd'), 'en', { executionId: randomUUID() })
    await vi.advanceTimersByTimeAsync(21)
    const batch = await promise
    expect(batch.outcome).toBe('partial')
    expect(batch.counts).toMatchObject({ saved: 1, failed: 3 })
    expect(analyze).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('honors a signal cancelled before execution without writes or model requests', async () => {
    const repository = memoryRepository()
    const analyze = vi.fn(async ({ phrase }: AnalyzePhraseInput) => insertResult(phrase))
    const module = new PhraseModule(repository, () => ({ analyze }))
    const controller = new AbortController()
    controller.abort()
    const batch = await module.addBatch(input('a'), 'en', {
      executionId: randomUUID(),
      signal: controller.signal
    })
    expect(batch.outcome).toBe('cancelled')
    expect(repository.contents).toHaveLength(0)
    expect(analyze).not.toHaveBeenCalled()
  })
  it('rejects invalid tool results and missing config without fake data', async () => {
    const repository = memoryRepository()
    const module = new PhraseModule(repository, () => ({
      analyze: async () => {
        throw new PhraseError('INVALID_ANALYSIS')
      }
    }))
    expect(
      (await module.addBatch(input('a'), 'en', { executionId: randomUUID() })).items[0]
    ).toMatchObject({
      code: 'INVALID_ANALYSIS'
    })
    const missing = new PhraseModule(repository, () => {
      throw new PhraseError('MODEL_NOT_CONFIGURED')
    })
    expect(
      (await missing.addBatch(input('a'), 'en', { executionId: randomUUID() })).items[0]
    ).toMatchObject({
      code: 'MODEL_NOT_CONFIGURED'
    })
    expect(repository.contents).toHaveLength(0)
  })
  it('escalates tool capability errors without committing a failed batch', async () => {
    const repository = memoryRepository()
    const save = vi.spyOn(repository, 'saveBatchWithResult')
    const module = new PhraseModule(repository, () => ({
      analyze: async () => {
        throw new PhraseError('TOOL_CALL_NOT_SUPPORTED')
      }
    }))
    await expect(
      module.addBatch(input('a'), 'en', { executionId: randomUUID() })
    ).rejects.toMatchObject({
      code: 'TOOL_CALL_NOT_SUPPORTED'
    })
    expect(save).not.toHaveBeenCalled()
    expect(repository.contents).toHaveLength(0)
  })
  it('refuses cancellation once synchronous commit starts', async () => {
    const repository = memoryRepository()
    const module = new PhraseModule(repository, () => ({
      analyze: async ({ phrase }: AnalyzePhraseInput) => insertResult(phrase)
    }))
    const request = input('a')
    const controller = new AbortController()
    const save = repository.saveBatchWithResult
    repository.saveBatchWithResult = (executionId, contents, finalize) => {
      controller.abort()
      return save(executionId, contents, finalize)
    }
    const batch = await module.addBatch(request, 'en', {
      executionId: randomUUID(),
      signal: controller.signal
    })
    expect(batch.outcome).toBe('completed')
    expect(batch.counts.saved).toBe(1)
    expect(repository.contents).toHaveLength(1)
  })
})
