import { describe, expect, it, vi } from 'vitest'
import type { SupportedLocale } from '../../../../shared/preferences'
import {
  EXPLORE_VOCABULARY_ITEM_COUNT,
  type ExploreVocabularyBatch,
  type ExploreVocabularyHistoryDocument
} from '../../../../shared/explore-vocabulary'
import { ExploreVocabularyError } from '../explore-vocabulary-error'
import type {
  ExploreVocabularyCandidate,
  ExploreVocabularyGenerator,
  ExploreVocabularyGenerateInput
} from '../explore-vocabulary-generator'
import type {
  CommitExploreVocabularyBatchInput,
  CommitExploreVocabularyBatchOptions,
  ExploreVocabularyHistoryStore
} from '../explore-vocabulary-history-store'
import { ExploreVocabularyModule } from '../explore-vocabulary-module'
import { normalizeExploreVocabularyTerm } from '../normalize-explore-vocabulary'

let uuidCounter = 0
function uuid(): string {
  uuidCounter += 1
  const suffix = String(uuidCounter).padStart(6, '0')
  return `550e8400-e29b-41d4-a716-446655${suffix}`
}

// 无数字词表：词条词形规则拒绝含数字的候选，测试数据必须符合词形。
const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet'
]

function makeItems(prefix: string): CommitExploreVocabularyBatchInput['items'] {
  return Array.from({ length: EXPLORE_VOCABULARY_ITEM_COUNT }, (_unused, index) => {
    const term = `${prefix}${WORDS[index]}`
    return {
      term,
      normalizedTerm: normalizeExploreVocabularyTerm(term),
      explanation: `释义 ${index}`,
      example: `An example with ${term} inside.`
    }
  })
}

function makeBatch(prefix: string): ExploreVocabularyBatch {
  return {
    executionId: uuid(),
    sessionId: uuid(),
    userMessageId: uuid(),
    committedAt: '2026-09-21T10:30:00.000Z',
    wordLanguage: 'en',
    explanationLanguage: 'zh-CN',
    items: makeItems(prefix)
  }
}

// 内存假存储：记录提交调用并按需返回预置文档。
class MemoryStore implements ExploreVocabularyHistoryStore {
  document: ExploreVocabularyHistoryDocument = { schemaVersion: 1, batches: [] }
  readonly commits: Array<{
    input: CommitExploreVocabularyBatchInput
    options: CommitExploreVocabularyBatchOptions
  }> = []

  async read(): Promise<ExploreVocabularyHistoryDocument> {
    return this.document
  }

  async findBatchByUserMessage(userMessageId: string): Promise<ExploreVocabularyBatch | undefined> {
    return (await this.read()).batches.find((batch) => batch.userMessageId === userMessageId)
  }

  async commit(
    input: CommitExploreVocabularyBatchInput,
    options: CommitExploreVocabularyBatchOptions
  ): Promise<ExploreVocabularyBatch> {
    this.commits.push({ input, options })
    const existing = this.document.batches.find(
      (batch) =>
        batch.executionId === input.executionId || batch.userMessageId === input.userMessageId
    )
    if (existing) return existing
    const batch: ExploreVocabularyBatch = { ...input }
    this.document = { schemaVersion: 1, batches: [...this.document.batches, batch] }
    return batch
  }
}

function candidate(
  term: string,
  overrides: Partial<ExploreVocabularyCandidate> = {}
): ExploreVocabularyCandidate {
  return {
    term,
    explanation: `关于 ${term} 的释义`,
    example: `A sentence that uses ${term} naturally.`,
    ...overrides
  }
}

function makeModule(
  store: MemoryStore,
  responses: Array<ExploreVocabularyCandidate[] | Error>,
  options: { onGenerate?: (input: ExploreVocabularyGenerateInput) => void } = {}
): ExploreVocabularyModule {
  let call = 0
  const generator: ExploreVocabularyGenerator = {
    async generate(input) {
      options.onGenerate?.(input)
      const response = responses[Math.min(call, responses.length - 1)]
      call += 1
      if (response instanceof Error) throw response
      return response
    }
  }
  return new ExploreVocabularyModule(store, () => generator, undefined, {
    requestMs: 60_000,
    totalMs: 180_000
  })
}

function makeOptions(
  overrides: Partial<Parameters<ExploreVocabularyModule['explore']>[0]> = {}
): Parameters<ExploreVocabularyModule['explore']>[0] {
  return {
    executionId: uuid(),
    sessionId: uuid(),
    userMessageId: uuid(),
    wordLanguage: 'en' as const,
    explanationLanguage: 'zh-CN' as SupportedLocale,
    ...overrides
  }
}

describe('ExploreVocabularyModule', () => {
  it('generates ten items in one call and commits the batch with the read snapshot', async () => {
    const store = new MemoryStore()
    const candidates = WORDS.map((word) => candidate(`gen${word}`))
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
    expect(result.batch.items.map((item) => item.term)).toEqual(candidates.map((item) => item.term))
    expect(onGenerate).toHaveBeenCalledTimes(1)
    expect(onGenerate.mock.calls[0][0]).toMatchObject({
      count: 10,
      wordLanguage: 'en',
      explanationLanguage: 'zh-CN',
      excludedTerms: []
    })
    expect(store.commits).toHaveLength(1)
    expect(store.commits[0].options.base).toEqual({ schemaVersion: 1, batches: [] })
    expect(phases).toEqual(['analyzing', 'committing'])
  })

  it('passes history terms as the exclusion list', async () => {
    const store = new MemoryStore()
    store.document = { schemaVersion: 1, batches: [makeBatch('history')] }
    const onGenerate = vi.fn()
    const module = makeModule(store, [WORDS.map((word) => candidate(`fresh${word}`))], {
      onGenerate
    })
    await module.explore(makeOptions())
    expect(onGenerate.mock.calls[0][0].excludedTerms).toEqual(
      makeBatch('history').items.map((item) => item.normalizedTerm)
    )
  })

  it('filters duplicates and unqualified terms, then tops up with the merged exclusion list', async () => {
    const store = new MemoryStore()
    store.document = { schemaVersion: 1, batches: [makeBatch('history')] }
    const first = [
      candidate('historyalpha'), // 历史重复
      candidate('dupword'), // 批内第一次
      candidate('dupword'), // 批内重复
      candidate('badexample', { example: 'Totally unrelated sentence.' }), // 例句不含单词
      candidate('emptyexplanation', { explanation: '   ' }), // 空释义
      candidate('multiline', { explanation: 'line\nline' }), // 换行
      candidate('multi word'), // 多词短语：不是单词
      candidate('b2b'), // 含数字：不是单词
      candidate('CaseWord'), // 大小写规范化后与下一项重复
      candidate('caseword') // 与上一项规范化后重复
    ]
    const topUp = WORDS.map((word) => candidate(`valid${word}`))
    const onGenerate = vi.fn()
    const module = makeModule(store, [first, topUp], { onGenerate })

    const result = await module.explore(makeOptions())
    if (result.outcome !== 'completed') throw new Error('expected completion')
    expect(onGenerate).toHaveBeenCalledTimes(2)
    // 首次 count=10；补足 count=8（首批接受 dupword 与 CaseWord，后者规范化
    // 后排除再次出现的 caseword）。
    expect(onGenerate.mock.calls[0][0].count).toBe(10)
    expect(onGenerate.mock.calls[1][0].count).toBe(8)
    // 禁用列表合并历史单词与本次已接受候选。
    expect(onGenerate.mock.calls[1][0].excludedTerms).toEqual(
      expect.arrayContaining(['historyalpha', 'dupword'])
    )
    expect(result.batch.items.map((item) => item.term)).toEqual([
      'dupword',
      'CaseWord',
      ...WORDS.slice(0, 8).map((word) => `valid${word}`)
    ])
  })

  it('accepts hyphenated and apostrophe terms and requires whole-word examples', async () => {
    const store = new MemoryStore()
    const candidates = [
      candidate('well-known', { example: 'He is a well-known author here.' }),
      candidate("don't", { example: "They don't know the answer." }),
      candidate('reliable'),
      ...WORDS.slice(0, 7).map((word) => candidate(`plain${word}`))
    ]
    const module = makeModule(store, [candidates])
    const result = await module.explore(makeOptions())
    if (result.outcome !== 'completed') throw new Error('expected completion')
    expect(result.batch.items.map((item) => item.term)).toContain('well-known')
    expect(result.batch.items.map((item) => item.term)).toContain("don't")
  })

  it('treats protocol errors as consumed attempts and fails after three', async () => {
    const store = new MemoryStore()
    const onGenerate = vi.fn()
    const module = makeModule(store, [new ExploreVocabularyError('INVALID_ANALYSIS')], {
      onGenerate
    })
    await expect(module.explore(makeOptions())).rejects.toMatchObject({
      code: 'GENERATION_FAILED'
    })
    expect(onGenerate).toHaveBeenCalledTimes(3)
    expect(store.commits).toHaveLength(0)
  })

  it('fails fast on communication errors without committing', async () => {
    const store = new MemoryStore()
    const onGenerate = vi.fn()
    const module = makeModule(store, [new ExploreVocabularyError('MODEL_ERROR')], { onGenerate })
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
    const generator: ExploreVocabularyGenerator = {
      generate: () =>
        new Promise((_resolve, reject) => {
          reject(new ExploreVocabularyError('CANCELLED'))
        })
    }
    const module = new ExploreVocabularyModule(store, () => generator, undefined, {
      requestMs: 60_000,
      totalMs: 180_000
    })
    const result = await module.explore(makeOptions())
    expect(result).toEqual({ outcome: 'cancelled' })
    expect(store.commits).toHaveLength(0)
  })

  it('checks the cancel signal one last time before committing', async () => {
    const store = new MemoryStore()
    const candidates = WORDS.map((word) => candidate(`late${word}`))
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
    const candidates = WORDS.map((word) => candidate(`prot${word}`))
    const module = makeModule(store, [candidates])
    const isProtected = vi.fn(() => false)
    await module.explore({ ...makeOptions(), isProtected })
    expect(store.commits).toHaveLength(1)
    expect(store.commits[0].options.isProtected).toBe(isProtected)
  })

  it('serializes explorations across its own lock without overlapping commits', async () => {
    const store = new MemoryStore()
    const timeline: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGenerator: ExploreVocabularyGenerator = {
      async generate() {
        timeline.push('first-generate-start')
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        timeline.push('first-generate-end')
        return WORDS.map((word) => candidate(`seriala${word}`))
      }
    }
    const secondGenerator: ExploreVocabularyGenerator = {
      async generate() {
        timeline.push('second-generate-start')
        return WORDS.map((word) => candidate(`serialb${word}`))
      }
    }
    let which = 0
    const module = new ExploreVocabularyModule(
      store,
      () => (which++ === 0 ? firstGenerator : secondGenerator),
      undefined,
      { requestMs: 60_000, totalMs: 180_000 }
    )
    const first = module.explore(makeOptions())
    await new Promise((resolve) => setTimeout(resolve, 10))
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
