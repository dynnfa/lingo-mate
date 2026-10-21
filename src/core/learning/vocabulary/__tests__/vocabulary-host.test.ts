import { afterEach, describe, expect, it, vi } from 'vitest'
import { VocabularyHostSession } from '../vocabulary-host'
import { insertCommand, insertResult, memoryRepository } from './fixtures'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('VocabularyHostSession', () => {
  it('keeps domain data local, stages validated content and commits once after graph completion', async () => {
    const repository = memoryRepository()
    repository.commands.push(insertCommand('banana'))
    const analyze = vi.fn(async ({ term }) => insertResult(term))
    const host = new VocabularyHostSession(
      repository,
      () => ({ analyze }),
      'apple,banana,apple',
      'en',
      'zh-CN'
    )
    expect(host.prepare()).toEqual({
      items: [
        { inputIndex: 0, term: 'apple', status: 'pending' },
        { inputIndex: 1, term: 'banana', status: 'existing' },
        { inputIndex: 2, term: 'apple', status: 'duplicate', sourceInputIndex: 0 }
      ]
    })
    expect(
      await host.analyze(
        { inputIndex: 0, systemPrompt: 'Explain in Chinese; examples in English.' },
        new AbortController().signal
      )
    ).toEqual({ inputIndex: 0, status: 'staged' })
    expect(repository.commands).toHaveLength(1)
    host.verifyCompletion({ completedIndices: [0] })
    const report = host.commit(crypto.randomUUID(), undefined)
    expect(report.counts).toEqual({ total: 3, saved: 1, existing: 1, duplicate: 1, failed: 0 })
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(() => host.commit(crypto.randomUUID(), undefined)).toThrow()
    expect(() => host.verifyCompletion({ completedIndices: [0, 0] })).toThrow()
  })
})

it('settles an ignored per-word timeout and never stages its late result', async () => {
  vi.useFakeTimers()
  const repository = memoryRepository()
  let complete!: (value: ReturnType<typeof insertResult>) => void
  let signal!: AbortSignal
  const host = new VocabularyHostSession(
    repository,
    () => ({
      analyze: (input) => {
        signal = input.signal
        return new Promise((resolve) => {
          complete = resolve
        })
      }
    }),
    'apple',
    'en',
    'en',
    { wordMs: 30, batchMs: 120 }
  )
  host.prepare()
  const pending = host.analyze(
    { inputIndex: 0, systemPrompt: 'Explain in English.' },
    new AbortController().signal
  )
  await vi.advanceTimersByTimeAsync(31)
  expect(await pending).toEqual({ inputIndex: 0, status: 'failed', code: 'TIMEOUT' })
  expect(signal.aborted).toBe(true)
  complete(insertResult('apple'))
  await Promise.resolve()
  host.verifyCompletion({ completedIndices: [0] })
  expect(host.commit(crypto.randomUUID()).counts).toMatchObject({ saved: 0, failed: 1 })
  expect(repository.commands).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps earlier valid results at the analysis deadline and never requests unstarted terms', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const repository = memoryRepository()
  const analyze = vi.fn(async ({ term }) => insertResult(term))
  const host = new VocabularyHostSession(
    repository,
    () => ({ analyze }),
    'apple,banana,orange,pear',
    'en',
    'en',
    { wordMs: 100, batchMs: 20 }
  )
  host.prepare()
  await host.analyze(
    { inputIndex: 0, systemPrompt: 'Explain in English.' },
    new AbortController().signal
  )
  now = 21
  for (const inputIndex of [1, 2, 3])
    expect(
      await host.analyze(
        { inputIndex, systemPrompt: 'Explain in English.' },
        new AbortController().signal
      )
    ).toEqual({ inputIndex, status: 'failed', code: 'TIMEOUT' })
  host.verifyCompletion({ completedIndices: [0, 1, 2, 3] })
  const batch = host.commit(crypto.randomUUID())
  expect(batch.outcome).toBe('partial')
  expect(batch.counts).toMatchObject({ saved: 1, failed: 3 })
  expect(analyze).toHaveBeenCalledTimes(1)
  expect(repository.commands).toHaveLength(1)
})
