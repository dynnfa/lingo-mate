import type { ExplorePhraseAgentRunInput } from '../../../agent/agent-runtime'
import { createTestBatchRuntime } from '../../../../../tests/fixtures/python-agent'
import { describe, expect, it, vi } from 'vitest'
import type { SupportedLocale } from '../../../../shared/preferences'
import {
  EXPLORE_PHRASE_ITEM_COUNT,
  type ExplorePhraseBatch,
  type ExplorePhraseHistoryDocument
} from '../../../../shared/explore-phrase'
import { ExplorePhraseError } from '../explore-phrase-error'
import type {
  ExplorePhraseCandidate,
  ExplorePhraseGenerator,
  ExplorePhraseGenerateInput
} from '../explore-phrase-generator'
import type {
  CommitExplorePhraseBatchInput,
  CommitExplorePhraseBatchOptions,
  ExplorePhraseHistoryStore
} from '../explore-phrase-history-store'
import { ExplorePhraseModule } from '../explore-phrase-module'
import { normalizeExplorePhrase } from '../normalize-explore-phrase'

let uuidCounter = 0
function uuid(): string {
  uuidCounter += 1
  const suffix = String(uuidCounter).padStart(6, '0')
  return `550e8400-e29b-41d4-a716-446655${suffix}`
}

function makeItems(prefix: string): CommitExplorePhraseBatchInput['items'] {
  return Array.from({ length: EXPLORE_PHRASE_ITEM_COUNT }, (_unused, index) => {
    const phrase = `${prefix} phrase ${index}`
    return {
      phrase,
      normalizedPhrase: normalizeExplorePhrase(phrase),
      explanation: `释义 ${index}`,
      example: `An example with ${phrase} inside.`
    }
  })
}

function makeBatch(prefix: string): ExplorePhraseBatch {
  return {
    executionId: uuid(),
    sessionId: uuid(),
    userMessageId: uuid(),
    committedAt: '2026-09-20T10:30:00.000Z',
    wordLanguage: 'en',
    explanationLanguage: 'zh-CN',
    items: makeItems(prefix)
  }
}

// 内存假存储：记录提交调用并按需返回预置文档。
class MemoryStore implements ExplorePhraseHistoryStore {
  document: ExplorePhraseHistoryDocument = { schemaVersion: 1, batches: [] }
  readonly commits: Array<{
    input: CommitExplorePhraseBatchInput
    options: CommitExplorePhraseBatchOptions
  }> = []
  commitShouldFail = false

  async read(): Promise<ExplorePhraseHistoryDocument> {
    if (this.commitShouldFail) throw new ExplorePhraseError('HISTORY_UNREADABLE')
    return this.document
  }

  async findBatchByUserMessage(userMessageId: string): Promise<ExplorePhraseBatch | undefined> {
    return (await this.read()).batches.find((batch) => batch.userMessageId === userMessageId)
  }

  async commit(
    input: CommitExplorePhraseBatchInput,
    options: CommitExplorePhraseBatchOptions
  ): Promise<ExplorePhraseBatch> {
    this.commits.push({ input, options })
    if (this.commitShouldFail) throw new ExplorePhraseError('STORAGE_FAILED')
    const existing = this.document.batches.find(
      (batch) =>
        batch.executionId === input.executionId || batch.userMessageId === input.userMessageId
    )
    if (existing) return existing
    const batch: ExplorePhraseBatch = { ...input }
    this.document = { schemaVersion: 1, batches: [...this.document.batches, batch] }
    return batch
  }
}

function candidate(
  phrase: string,
  overrides: Partial<ExplorePhraseCandidate> = {}
): ExplorePhraseCandidate {
  return {
    phrase,
    explanation: `关于 ${phrase} 的释义`,
    example: `A sentence that uses ${phrase} naturally.`,
    ...overrides
  }
}

function makeModule(
  store: MemoryStore,
  responses: Array<ExplorePhraseCandidate[] | Error>,
  options: { onGenerate?: (input: ExplorePhraseGenerateInput) => void } = {}
): ExplorePhraseModule {
  let call = 0
  const generator: ExplorePhraseGenerator = {
    async generate(input) {
      options.onGenerate?.(input)
      const response = responses[Math.min(call, responses.length - 1)]
      call += 1
      if (response instanceof Error) throw response
      return response
    }
  }
  return new ExplorePhraseModule(store, () => generator, createTestBatchRuntime(), undefined, {
    requestMs: 60_000,
    totalMs: 180_000
  })
}

function makeOptions(
  overrides: Partial<Parameters<ExplorePhraseModule['explore']>[0]> = {}
): Parameters<ExplorePhraseModule['explore']>[0] {
  return {
    executionId: uuid(),
    sessionId: uuid(),
    userMessageId: uuid(),
    wordLanguage: 'en' as const,
    explanationLanguage: 'zh-CN' as SupportedLocale,
    ...overrides
  }
}

describe('ExplorePhraseModule', () => {
  it('generates ten items in one call and commits the batch with the read snapshot', async () => {
    const store = new MemoryStore()
    const candidates = Array.from({ length: 10 }, (_unused, index) => candidate(`gen ${index}`))
    const onGenerate = vi.fn()
    const module = makeModule(store, [candidates], { onGenerate })
    const phases: string[] = []
    const result = await module.explore({
      ...makeOptions(),
      onPhase: (phase) => {
        phases.push(phase)
      }
    })

    expect(result.outcome).toBe('completed')
    if (result.outcome !== 'completed') throw new Error('unreachable')
    expect(result.batch.items).toHaveLength(10)
    expect(result.batch.items.map((item) => item.phrase)).toEqual(
      candidates.map((item) => item.phrase)
    )
    expect(onGenerate).toHaveBeenCalledTimes(1)
    expect(onGenerate.mock.calls[0][0]).toMatchObject({
      count: 10,
      wordLanguage: 'en',
      explanationLanguage: 'zh-CN',
      excludedPhrases: []
    })
    expect(store.commits).toHaveLength(1)
    expect(store.commits[0].options.base).toEqual({ schemaVersion: 1, batches: [] })
    expect(phases).toEqual(['analyzing', 'committing'])
  })

  it('passes history phrases as the exclusion list', async () => {
    const store = new MemoryStore()
    store.document = { schemaVersion: 1, batches: [makeBatch('history')] }
    const onGenerate = vi.fn()
    const module = makeModule(
      store,
      [Array.from({ length: 10 }, (_unused, index) => candidate(`fresh ${index}`))],
      { onGenerate }
    )
    await module.explore(makeOptions())
    expect(onGenerate.mock.calls[0][0].excludedPhrases).toEqual(
      makeBatch('history').items.map((item) => item.normalizedPhrase)
    )
  })

  it('filters duplicates and unqualified candidates, then tops up with the merged exclusion list', async () => {
    const store = new MemoryStore()
    store.document = { schemaVersion: 1, batches: [makeBatch('history')] }
    const first = [
      candidate('history phrase 0'), // 历史重复
      candidate('dup phrase'), // 批内第一次
      candidate('dup phrase'), // 批内重复
      candidate('bad example', { example: 'Totally unrelated sentence.' }), // 例句不含短语
      candidate('empty explanation', { explanation: '   ' }), // 空释义
      candidate('multiline', { explanation: 'line\nline' }), // 换行
      candidate('case variant'), // 大小写规范化后与下一项重复
      candidate('Case  Variant'), // 规范化为 case variant
      candidate('valid 0'),
      candidate('valid 1')
    ]
    const topUp = Array.from({ length: 6 }, (_unused, index) => candidate(`valid ${index + 2}`))
    const onGenerate = vi.fn()
    const module = makeModule(store, [first, topUp], { onGenerate })

    const result = await module.explore(makeOptions())
    if (result.outcome !== 'completed') throw new Error('expected completion')
    expect(onGenerate).toHaveBeenCalledTimes(2)
    // 首次 count=10；补足 count=6（首批接受 dup phrase / case variant / valid 0 / valid 1）。
    expect(onGenerate.mock.calls[0][0].count).toBe(10)
    expect(onGenerate.mock.calls[1][0].count).toBe(6)
    // 禁用列表合并历史短语与本次已接受候选。
    expect(onGenerate.mock.calls[1][0].excludedPhrases).toEqual(
      expect.arrayContaining([
        'history phrase 0',
        'dup phrase',
        'case variant',
        'valid 0',
        'valid 1'
      ])
    )
    expect(result.batch.items.map((item) => item.phrase)).toEqual([
      'dup phrase',
      'case variant',
      'valid 0',
      'valid 1',
      ...Array.from({ length: 6 }, (_unused, index) => `valid ${index + 2}`)
    ])
  })

  it('treats protocol errors as consumed attempts and fails after three', async () => {
    const store = new MemoryStore()
    const onGenerate = vi.fn()
    const module = makeModule(store, [new ExplorePhraseError('INVALID_ANALYSIS')], { onGenerate })
    await expect(module.explore(makeOptions())).rejects.toMatchObject({
      code: 'GENERATION_FAILED'
    })
    expect(onGenerate).toHaveBeenCalledTimes(3)
    expect(store.commits).toHaveLength(0)
  })

  it('fails fast on communication errors without committing', async () => {
    const store = new MemoryStore()
    const onGenerate = vi.fn()
    const module = makeModule(store, [new ExplorePhraseError('MODEL_ERROR')], { onGenerate })
    await expect(module.explore(makeOptions())).rejects.toMatchObject({ code: 'MODEL_ERROR' })
    expect(onGenerate).toHaveBeenCalledTimes(1)
    expect(store.commits).toHaveLength(0)
  })

  it('returns the existing batch without calling the model for a repeated identity', async () => {
    const store = new MemoryStore()
    const batch = makeBatch('existing')
    store.document = { schemaVersion: 1, batches: [batch] }
    const onGenerate = vi.fn()
    const module = makeModule(store, [[]], { onGenerate })

    const byExecution = await module.explore(makeOptions({ executionId: batch.executionId }))
    expect(byExecution).toEqual({ outcome: 'completed', batch })
    const byUserMessage = await module.explore(makeOptions({ userMessageId: batch.userMessageId }))
    expect(byUserMessage).toEqual({ outcome: 'completed', batch })
    expect(onGenerate).not.toHaveBeenCalled()
    expect(store.commits).toHaveLength(0)
  })

  it('reports cancellation without writing the batch', async () => {
    const store = new MemoryStore()
    const generator: ExplorePhraseGenerator = {
      generate: () =>
        new Promise((_resolve, reject) => {
          reject(new ExplorePhraseError('CANCELLED'))
        })
    }
    const module = new ExplorePhraseModule(
      store,
      () => generator,
      createTestBatchRuntime(),
      undefined,
      {
        requestMs: 60_000,
        totalMs: 180_000
      }
    )
    const result = await module.explore(makeOptions())
    expect(result).toEqual({ outcome: 'cancelled' })
    expect(store.commits).toHaveLength(0)
  })

  it('checks the cancel signal one last time before committing', async () => {
    const store = new MemoryStore()
    const candidates = Array.from({ length: 10 }, (_unused, index) => candidate(`late ${index}`))
    const module = makeModule(store, [candidates])
    const controller = new AbortController()
    const result = await module.explore({
      ...makeOptions(),
      signal: controller.signal,
      onPhase: (phase) => {
        if (phase === 'committing') controller.abort()
      }
    })
    expect(result).toEqual({ outcome: 'cancelled' })
    expect(store.commits).toHaveLength(0)
  })

  it('forwards the protection callback to the store commit', async () => {
    const store = new MemoryStore()
    const candidates = Array.from({ length: 10 }, (_unused, index) => candidate(`prot ${index}`))
    const module = makeModule(store, [candidates])
    const isProtected = vi.fn(() => false)
    await module.explore({ ...makeOptions(), isProtected })
    expect(store.commits).toHaveLength(1)
    expect(store.commits[0].options.isProtected).toBe(isProtected)
  })

  it('waits for an in-flight commit before settling cancellation or releasing the lock', async () => {
    const store = new MemoryStore()
    let finishCommit!: () => void
    const originalCommit = store.commit.bind(store)
    vi.spyOn(store, 'commit').mockImplementationOnce(async (input, options) => {
      await new Promise<void>((resolve) => {
        finishCommit = resolve
      })
      return originalCommit(input, options)
    })
    const onGenerate = vi.fn()
    const module = makeModule(
      store,
      [
        Array.from({ length: 10 }, (_, i) => candidate(`first ${i}`)),
        Array.from({ length: 10 }, (_, i) => candidate(`second ${i}`))
      ],
      { onGenerate }
    )
    const controller = new AbortController()
    const settled = vi.fn()
    const first = module.explore(makeOptions({ signal: controller.signal })).then((result) => {
      settled(result)
      return result
    })
    await vi.waitFor(() => expect(finishCommit).toBeDefined())
    controller.abort()
    const second = module.explore(makeOptions())
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(settled).not.toHaveBeenCalled()
      expect(onGenerate).toHaveBeenCalledTimes(1)
    } finally {
      finishCommit()
      await Promise.all([first, second])
    }
    expect(await first).toMatchObject({ outcome: 'completed' })
    expect(store.document.batches).toHaveLength(2)
  })

  it('serializes explorations across the shared lock without overlapping commits', async () => {
    const store = new MemoryStore()
    const timeline: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGenerator: ExplorePhraseGenerator = {
      async generate() {
        timeline.push('first-generate-start')
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        timeline.push('first-generate-end')
        return Array.from({ length: 10 }, (_unused, index) => candidate(`serial a ${index}`))
      }
    }
    const secondGenerator: ExplorePhraseGenerator = {
      async generate() {
        timeline.push('second-generate-start')
        return Array.from({ length: 10 }, (_unused, index) => candidate(`serial b ${index}`))
      }
    }
    let which = 0
    const module = new ExplorePhraseModule(
      store,
      () => (which++ === 0 ? firstGenerator : secondGenerator),
      createTestBatchRuntime(),
      undefined,
      { requestMs: 60_000, totalMs: 180_000 }
    )
    const first = module.explore(makeOptions())
    await vi.waitFor(() => expect(releaseFirst).toBeDefined())
    const second = module.explore(makeOptions())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(timeline).toEqual(['first-generate-start'])
    releaseFirst?.()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.outcome).toBe('completed')
    expect(secondResult.outcome).toBe('completed')
    expect(timeline).toEqual([
      'first-generate-start',
      'first-generate-end',
      'second-generate-start'
    ])
    expect(store.document.batches).toHaveLength(2)
  })
})

it('includes engine startup in the 180 second deadline and aborts an unresponsive runtime', async () => {
  vi.useFakeTimers()
  const store = new MemoryStore()
  let runSignal: AbortSignal | undefined
  const runExplorePhrase = vi.fn(async (input: ExplorePhraseAgentRunInput) => {
    runSignal = input.signal
    await new Promise<void>(() => {})
  })
  const module = new ExplorePhraseModule(
    store,
    () => {
      throw new Error('unused')
    },
    { runExplorePhrase }
  )
  try {
    const pending = module.explore(makeOptions())
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(180_000)
    await rejected
    expect(runSignal?.aborted).toBe(true)
    expect(runExplorePhrase).toHaveBeenCalledTimes(1)
    expect(store.commits).toHaveLength(0)
  } finally {
    vi.useRealTimers()
  }
})
