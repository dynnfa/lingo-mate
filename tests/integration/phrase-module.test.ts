import { createTestPhraseRuntime } from '../fixtures/python-agent'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhraseModule } from '../../src/core/learning/phrase/phrase-module'
import { PhraseError } from '../../src/core/learning/phrase/parse-phrase-input'
import type {
  AnalyzePhraseInput,
  PhraseAnalysisResult
} from '../../src/core/learning/phrase/phrase-analyzer'
import {
  insertResult,
  content,
  memoryRepository
} from '../../src/core/learning/phrase/__tests__/fixtures'

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
    const module = new PhraseModule(repository, factory, createTestPhraseRuntime())
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
    const module = new PhraseModule(
      repository,
      () => ({
        analyze: async ({ phrase }: AnalyzePhraseInput) => insertResult(phrase)
      }),
      createTestPhraseRuntime()
    )
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
    const module = new PhraseModule(repository, () => ({ analyze }), createTestPhraseRuntime())
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
    const module = new PhraseModule(
      repository,
      () => ({
        analyze: async ({ phrase }: AnalyzePhraseInput) => insertResult(phrase)
      }),
      createTestPhraseRuntime()
    )
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
    const module = new PhraseModule(repository, () => ({ analyze }), createTestPhraseRuntime())
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
  it('honors a signal cancelled before execution without writes or model requests', async () => {
    const repository = memoryRepository()
    const analyze = vi.fn(async ({ phrase }: AnalyzePhraseInput) => insertResult(phrase))
    const module = new PhraseModule(repository, () => ({ analyze }), createTestPhraseRuntime())
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
    const module = new PhraseModule(
      repository,
      () => ({
        analyze: async () => {
          throw new PhraseError('INVALID_ANALYSIS')
        }
      }),
      createTestPhraseRuntime()
    )
    expect(
      (await module.addBatch(input('a'), 'en', { executionId: randomUUID() })).items[0]
    ).toMatchObject({
      code: 'INVALID_ANALYSIS'
    })
    const missing = new PhraseModule(
      repository,
      () => {
        throw new PhraseError('MODEL_NOT_CONFIGURED')
      },
      createTestPhraseRuntime()
    )
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
    const module = new PhraseModule(
      repository,
      () => ({
        analyze: async () => {
          throw new PhraseError('TOOL_CALL_NOT_SUPPORTED')
        }
      }),
      createTestPhraseRuntime()
    )
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
    const module = new PhraseModule(
      repository,
      () => ({
        analyze: async ({ phrase }: AnalyzePhraseInput) => insertResult(phrase)
      }),
      createTestPhraseRuntime()
    )
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
  it('honors cancellation during the committing phase before the transaction begins', async () => {
    const repository = memoryRepository()
    const save = vi.spyOn(repository, 'saveBatchWithResult')
    const module = new PhraseModule(
      repository,
      () => ({
        analyze: async ({ phrase }) => insertResult(phrase)
      }),
      createTestPhraseRuntime()
    )
    const controller = new AbortController()
    const batch = await module.addBatch(input('look forward to'), 'en', {
      executionId: randomUUID(),
      signal: controller.signal,
      onPhase: (phase) => {
        if (phase === 'committing') controller.abort()
      }
    })
    expect(batch.outcome).toBe('cancelled')
    expect(save).not.toHaveBeenCalled()
    expect(repository.contents).toEqual([])
  })
})
