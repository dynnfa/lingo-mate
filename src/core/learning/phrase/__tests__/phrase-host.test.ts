import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhraseHostSession } from '../phrase-host'
import { content, insertResult, memoryRepository } from './fixtures'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PhraseHostSession', () => {
  it('keeps domain data local, stages validated content and commits once after graph completion', async () => {
    const repository = memoryRepository()
    repository.contents.push(content('break even'))
    const analyze = vi.fn(async ({ phrase }) => insertResult(phrase))
    const host = new PhraseHostSession(
      repository,
      () => ({ analyze }),
      'look  forward to\nbreak even\nlook forward to',
      'en',
      'zh-CN'
    )
    expect(host.prepare()).toEqual({
      items: [
        { inputIndex: 0, phrase: 'look forward to', status: 'pending' },
        { inputIndex: 1, phrase: 'break even', status: 'existing' },
        { inputIndex: 2, phrase: 'look forward to', status: 'duplicate', sourceInputIndex: 0 }
      ]
    })
    expect(
      await host.analyze(
        { inputIndex: 0, systemPrompt: 'Explain in Chinese; examples in English.' },
        new AbortController().signal
      )
    ).toEqual({ inputIndex: 0, status: 'staged' })
    expect(repository.contents).toHaveLength(1)
    host.verifyCompletion({ completedIndices: [0] })
    const report = host.commit(crypto.randomUUID(), crypto.randomUUID())
    expect(report.counts).toEqual({ total: 3, saved: 1, existing: 1, duplicate: 1, failed: 0 })
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(() => host.commit(crypto.randomUUID(), crypto.randomUUID())).toThrow()
    expect(() => host.verifyCompletion({ completedIndices: [0, 0] })).toThrow()
  })

  it('rejects altered content and retains the original input identity in its report', async () => {
    const repository = memoryRepository()
    const host = new PhraseHostSession(
      repository,
      () => ({ analyze: async () => insertResult('replacement phrase') }),
      'look  forward to',
      'en',
      'en'
    )
    host.prepare()
    expect(
      await host.analyze(
        { inputIndex: 0, systemPrompt: 'Explain in English.' },
        new AbortController().signal
      )
    ).toEqual({ inputIndex: 0, status: 'failed', code: 'INVALID_ANALYSIS' })
    host.verifyCompletion({ completedIndices: [0] })
    expect(host.commit(crypto.randomUUID(), crypto.randomUUID()).items[0]).toMatchObject({
      input: 'look  forward to',
      phrase: 'look forward to',
      status: 'failed',
      code: 'INVALID_ANALYSIS'
    })
    expect(repository.contents).toEqual([])
  })

  it('requires every pending index exactly once before permitting a commit', async () => {
    const repository = memoryRepository()
    const host = new PhraseHostSession(
      repository,
      () => ({ analyze: async ({ phrase }) => insertResult(phrase) }),
      'look forward to\nbreak even',
      'en',
      'en'
    )
    const signal = new AbortController().signal
    await expect(
      host.analyze({ inputIndex: 0, systemPrompt: 'English' }, signal)
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    host.prepare()
    await host.analyze({ inputIndex: 0, systemPrompt: 'English' }, signal)
    expect(() => host.verifyCompletion({ completedIndices: [0, 1] })).toThrow()
    expect(() => host.commit(crypto.randomUUID(), crypto.randomUUID())).toThrow()
    await expect(
      host.analyze({ inputIndex: 0, systemPrompt: 'English' }, signal)
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    await host.analyze({ inputIndex: 1, systemPrompt: 'English' }, signal)
    expect(() => host.verifyCompletion({ completedIndices: [0, 0] })).toThrow()
    host.verifyCompletion({ completedIndices: [1, 0] })
    expect(host.commit(crypto.randomUUID(), crypto.randomUUID()).counts.saved).toBe(2)
  })
})

it('settles an ignored per-phrase timeout and never stages its late result', async () => {
  vi.useFakeTimers()
  const repository = memoryRepository()
  let complete!: (value: ReturnType<typeof insertResult>) => void
  let signal!: AbortSignal
  const host = new PhraseHostSession(
    repository,
    () => ({
      analyze: (input) => {
        signal = input.signal
        return new Promise((resolve) => {
          complete = resolve
        })
      }
    }),
    'look forward to',
    'en',
    'en',
    { phraseMs: 30, batchMs: 120 }
  )
  host.prepare()
  const pending = host.analyze(
    { inputIndex: 0, systemPrompt: 'Explain in English.' },
    new AbortController().signal
  )
  await vi.advanceTimersByTimeAsync(31)
  expect(await pending).toEqual({ inputIndex: 0, status: 'failed', code: 'TIMEOUT' })
  expect(signal.aborted).toBe(true)
  complete(insertResult('look forward to'))
  await Promise.resolve()
  host.verifyCompletion({ completedIndices: [0] })
  expect(host.commit(crypto.randomUUID(), crypto.randomUUID()).counts).toMatchObject({
    saved: 0,
    failed: 1
  })
  expect(repository.contents).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps earlier valid results at the analysis deadline and never requests unstarted phrases', async () => {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const repository = memoryRepository()
  const analyze = vi.fn(async ({ phrase }) => insertResult(phrase))
  const host = new PhraseHostSession(
    repository,
    () => ({ analyze }),
    'look forward to\nbreak even\npiece of cake\npear',
    'en',
    'en',
    { phraseMs: 100, batchMs: 20 }
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
  const batch = host.commit(crypto.randomUUID(), crypto.randomUUID())
  expect(batch.outcome).toBe('partial')
  expect(batch.counts).toMatchObject({ saved: 1, failed: 3 })
  expect(analyze).toHaveBeenCalledTimes(1)
  expect(repository.contents).toHaveLength(1)
})
