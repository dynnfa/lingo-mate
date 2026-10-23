import type { ExploreVocabularyCandidate } from '../explore-vocabulary-generator'
import { describe, expect, it, vi } from 'vitest'
import { ExploreVocabularyHostSession } from '../explore-vocabulary-host'

const signal = (): AbortSignal => new AbortController().signal
const items = (count: number, prefix = 'commonword'): ExploreVocabularyCandidate[] =>
  Array.from({ length: count }, (_, i) => ({
    term: `${prefix}${String.fromCharCode(97 + i)}`,
    explanation: 'An explanation',
    example: `We use ${prefix}${String.fromCharCode(97 + i)} in this sentence.`
  }))

describe('ExploreVocabularyHostSession', () => {
  it('keeps learning content private and releases ten items only after verified completion', async () => {
    const generate = vi.fn(async () => items(10))
    const createGenerator = vi.fn(() => ({ generate }))
    const host = new ExploreVocabularyHostSession(
      { schemaVersion: 1, batches: [] },
      createGenerator,
      'en',
      'en'
    )
    expect(() => host.completedItems()).toThrow()
    expect(host.prepare()).toEqual({ acceptedCount: 0, inputChars: expect.any(Number) })
    const receipt = await host.model(
      { attempt: 1, systemPrompt: 'Explain in English.' },
      signal(),
      65536
    )
    expect(receipt).toEqual({ attempt: 1, acceptedCount: 10, inputChars: 0 })
    expect(() => host.completedItems()).toThrow()
    host.verifyCompletion({ attempts: 1, acceptedCount: 10 })
    expect(host.completedItems()).toHaveLength(10)
    expect(createGenerator).toHaveBeenCalledTimes(1)
  })
})

it('binds attempts and rejects overlapping work and forged completion', async () => {
  let release!: (value: ReturnType<typeof items>) => void
  const generate = vi.fn(
    () =>
      new Promise<ReturnType<typeof items>>((resolve) => {
        release = resolve
      })
  )
  const host = new ExploreVocabularyHostSession(
    { schemaVersion: 1, batches: [] },
    () => ({ generate }),
    'en',
    'en'
  )
  const args = { attempt: 1, systemPrompt: 'Explain in English.' }
  await expect(host.model(args, signal(), 65536)).rejects.toMatchObject({
    code: 'AGENT_PROTOCOL_ERROR'
  })
  host.prepare()
  expect(() => host.prepare()).toThrow()
  await expect(host.model({ ...args, attempt: 2 }, signal(), 65536)).rejects.toMatchObject({
    code: 'AGENT_PROTOCOL_ERROR'
  })
  const pending = host.model(args, signal(), 65536)
  await expect(host.model({ ...args, attempt: 2 }, signal(), 65536)).rejects.toMatchObject({
    code: 'AGENT_PROTOCOL_ERROR'
  })
  expect(() => host.verifyCompletion({ attempts: 1, acceptedCount: 10 })).toThrow()
  release(items(4))
  await pending
  await expect(host.model(args, signal(), 65536)).rejects.toMatchObject({
    code: 'AGENT_PROTOCOL_ERROR'
  })
  expect(() => host.verifyCompletion({ attempts: 1, acceptedCount: 10 })).toThrow()
  expect(() => host.verifyCompletion({ attempts: 1, acceptedCount: 4 })).toThrow()
  expect(generate).toHaveBeenCalledTimes(1)
})

it('uses one model snapshot across top-up attempts', async () => {
  const generate = vi
    .fn()
    .mockResolvedValueOnce(items(4))
    .mockResolvedValueOnce(items(6, 'freshword'))
  const createGenerator = vi.fn(() => ({ generate }))
  const host = new ExploreVocabularyHostSession(
    { schemaVersion: 1, batches: [] },
    createGenerator,
    'en',
    'zh-CN'
  )
  host.prepare()
  await host.model(
    { attempt: 1, systemPrompt: 'Chinese explanations; English examples.' },
    signal(),
    65536
  )
  await host.model(
    { attempt: 2, systemPrompt: 'Chinese explanations; English examples.' },
    signal(),
    65536
  )
  host.verifyCompletion({ attempts: 2, acceptedCount: 10 })
  expect(generate.mock.calls[1][0]).toMatchObject({
    count: 6,
    excludedTerms: items(4).map((item) => item.term)
  })
  expect(createGenerator).toHaveBeenCalledTimes(1)
})

it('checks actual structured input size before requesting a model', async () => {
  const generate = vi.fn(async () => items(10))
  const host = new ExploreVocabularyHostSession(
    { schemaVersion: 1, batches: [] },
    () => ({ generate }),
    'en',
    'en'
  )
  const prepared = host.prepare()
  await expect(
    host.model({ attempt: 1, systemPrompt: 'English.' }, signal(), prepared.inputChars)
  ).rejects.toMatchObject({ code: 'AGENT_LIMIT' })
  expect(generate).not.toHaveBeenCalled()
})
