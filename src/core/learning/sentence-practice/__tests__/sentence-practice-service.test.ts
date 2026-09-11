import { describe, expect, it, vi } from 'vitest'
import type { VocabularyEntry } from '../../../../shared/vocabulary'
import type { SentencePracticeReview } from '../../../../shared/sentence-practice'
import type {
  SentenceHint,
  SentenceHintGenerator,
  SentencePracticeReviewer
} from '../sentence-practice-models'
import { SentencePracticeService } from '../sentence-practice-service'
import { SentencePracticeError } from '../parse-sentence-practice-input'

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
]

const REQUEST_ID = '44444444-4444-4444-8444-444444444444'

function entry(index: number, overrides: Partial<VocabularyEntry> = {}): VocabularyEntry {
  return {
    id: UUIDS[index],
    term: `word-${index}`,
    phonetic: null,
    meaning: `释义-${index}`,
    concept: null,
    exampleSentences: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides
  }
}

const HINTS: SentenceHint[] = [
  { entryIds: [UUIDS[0]], phrase: 'eat an apple', explanation: '吃一个苹果' },
  { entryIds: [UUIDS[1]], phrase: 'a bunch of bananas', explanation: '一串香蕉' },
  { entryIds: [UUIDS[2]], phrase: 'ripe cherries', explanation: '成熟的樱桃' }
]

const REVIEW: SentencePracticeReview = {
  wordUsage: UUIDS.map((entryId) => ({
    entryId,
    used: true,
    correct: true,
    feedback: '使用正确。'
  })),
  fluency: { natural: true, feedback: '整体通顺。' },
  grammar: { correct: true, issues: [] },
  summary: '全部正确。',
  revisedAnswer: null
}

// 可控的假提示生成器：每次调用创建新的挂起 Promise，
// resolve 只作用于最近一次调用，并记录收到的输入。
function pendingGenerator(): {
  generator: SentenceHintGenerator
  received: () => { entryId: string; term: string; referenceMeaning: string | null }[] | undefined
  resolve: (hints: SentenceHint[]) => void
} {
  let receivedInput: Parameters<SentenceHintGenerator['generate']>[0] | undefined
  let resolveLatest!: (hints: SentenceHint[]) => void
  const generator: SentenceHintGenerator = {
    async generate(input) {
      receivedInput = input
      return new Promise<SentenceHint[]>((resolve) => {
        resolveLatest = resolve
      })
    }
  }
  return {
    generator,
    received: () => receivedInput?.entries,
    // generate 在 abortableOperation 的微任务中才被调用，resolve 同样
    // 推迟到微任务，保证 resolveLatest 已被赋值。
    resolve: (hints) => void Promise.resolve().then(() => resolveLatest(hints))
  }
}

// 可控的假点评器：挂起 review 让调用方决定完成时机，并记录输入。
function pendingReviewer(): {
  reviewer: SentencePracticeReviewer
  received: () => Parameters<SentencePracticeReviewer['review']>[0] | undefined
  resolve: (review: SentencePracticeReview) => void
} {
  let receivedInput: Parameters<SentencePracticeReviewer['review']>[0] | undefined
  let resolveLatest!: (review: SentencePracticeReview) => void
  const reviewer: SentencePracticeReviewer = {
    async review(input) {
      receivedInput = input
      return new Promise<SentencePracticeReview>((resolve) => {
        resolveLatest = resolve
      })
    }
  }
  return {
    reviewer,
    received: () => receivedInput,
    resolve: (review) => void Promise.resolve().then(() => resolveLatest(review))
  }
}

function service(
  entries: VocabularyEntry[],
  options: {
    generator?: SentenceHintGenerator
    reviewer?: SentencePracticeReviewer
    hintsTimeoutMs?: number
    reviewTimeoutMs?: number
    onCreateGenerator?: () => void
  } = {}
): SentencePracticeService {
  return new SentencePracticeService(
    { sampleRandom: (count) => entries.slice(0, count) },
    () => {
      options.onCreateGenerator?.()
      return options.generator ?? pendingGenerator().generator
    },
    () => options.reviewer ?? pendingReviewer().reviewer,
    options.hintsTimeoutMs ?? 5_000,
    options.reviewTimeoutMs ?? 5_000
  )
}

describe('sentence practice service', () => {
  it('samples exactly three distinct entries and dedups repeated repository ids', () => {
    const duplicated = [entry(0), entry(0), entry(2)]
    const svc = service(duplicated)
    const round = svc.start()
    expect(round.entries).toEqual([
      { entryId: UUIDS[0], term: 'word-0' },
      { entryId: UUIDS[2], term: 'word-2' }
    ])
  })

  it('rejects a repository returning more entries than requested', () => {
    const sample = vi.fn(() => [entry(0), entry(1), entry(2), entry(2)])
    const svc = new SentencePracticeService(
      { sampleRandom: () => sample() },
      () => pendingGenerator().generator,
      () => pendingReviewer().reviewer
    )
    expect(() => svc.start()).toThrow(SentencePracticeError)
  })

  it('starts with fewer entries when the vocabulary is short and never calls the model', async () => {
    const onCreateGenerator = vi.fn()
    const svc = service([entry(0), entry(1)], { onCreateGenerator })
    const round = svc.start()
    expect(round.entries).toHaveLength(2)
    // 词库不足 3 个：提示与点评都不发起模型调用
    await expect(
      svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      svc.review(round.sessionId, REQUEST_ID, '答案', 'zh-CN', 'en')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(onCreateGenerator).not.toHaveBeenCalled()
  })

  it('generates hints from the snapshot with nullable reference meanings', async () => {
    const { generator, received, resolve } = pendingGenerator()
    const noMeaning = entry(1, { meaning: null })
    const svc = service([entry(0), noMeaning, entry(2)], { generator })
    const round = svc.start()
    const pending = svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    resolve(HINTS)
    await expect(pending).resolves.toEqual(HINTS)
    expect(received()).toEqual([
      { entryId: UUIDS[0], term: 'word-0', referenceMeaning: '释义-0' },
      { entryId: UUIDS[1], term: 'word-1', referenceMeaning: null },
      { entryId: UUIDS[2], term: 'word-2', referenceMeaning: '释义-2' }
    ])
  })

  it('rejects hint results that break the count, id or coverage contract', async () => {
    const invalidSets: SentenceHint[][] = [
      HINTS.slice(0, 2),
      [...HINTS, ...HINTS, ...HINTS, HINTS[0]],
      [
        ...HINTS.slice(0, 2),
        { entryIds: ['99999999-9999-4999-8999-999999999999'], phrase: 'x', explanation: 'y' }
      ],
      [...HINTS.slice(0, 2), { entryIds: [UUIDS[0]], phrase: 'x', explanation: 'y' }],
      [{ ...HINTS[0], entryIds: [UUIDS[0], UUIDS[0]] }, HINTS[1], HINTS[2]]
    ]
    for (const hints of invalidSets) {
      const { generator, resolve } = pendingGenerator()
      const svc = service([entry(0), entry(1), entry(2)], { generator })
      const round = svc.start()
      const pending = svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
      resolve(hints)
      await expect(pending).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    }
  })

  it('replaces stored hints when regenerating for the same session', async () => {
    const { generator, resolve } = pendingGenerator()
    const { reviewer, received: receivedReview, resolve: resolveReview } = pendingReviewer()
    const svc = service([entry(0), entry(1), entry(2)], { generator, reviewer })
    const round = svc.start()
    const first = svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    resolve(HINTS)
    await expect(first).resolves.toEqual(HINTS)

    const replacement: SentenceHint[] = [
      { entryIds: [UUIDS[0], UUIDS[1]], phrase: 'apple and banana', explanation: '苹果和香蕉' },
      { entryIds: [UUIDS[2]], phrase: 'cherry pie', explanation: '樱桃派' },
      { entryIds: [UUIDS[2]], phrase: 'two cherries', explanation: '两颗樱桃' }
    ]
    const second = svc.generateHints(
      round.sessionId,
      '66666666-6666-4666-8666-666666666666',
      'zh-CN',
      'en'
    )
    resolve(replacement)
    await expect(second).resolves.toEqual(replacement)

    // 点评使用最新一次的提示快照
    const reviewCall = svc.review(round.sessionId, REQUEST_ID, '答案', 'zh-CN', 'en')
    resolveReview(REVIEW)
    await reviewCall
    expect(receivedReview()?.hints).toEqual(replacement)
  })

  it('requires hints before reviewing and validates the answer bounds', async () => {
    const { reviewer } = pendingReviewer()
    const { generator, resolve } = pendingGenerator()
    const svc = service([entry(0), entry(1), entry(2)], { generator, reviewer })
    const round = svc.start()
    // 提示未生成前不可提交点评
    await expect(
      svc.review(round.sessionId, REQUEST_ID, '答案', 'zh-CN', 'en')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const hintsCall = svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    resolve(HINTS)
    await hintsCall

    for (const answer of ['', '   ', 'a'.repeat(2001)]) {
      await expect(
        svc.review(round.sessionId, REQUEST_ID, answer, 'zh-CN', 'en')
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
  })

  it('reviews with snapshot entries, stored hints and the trimmed answer', async () => {
    const { generator, resolve: resolveHints } = pendingGenerator()
    const { reviewer, received, resolve } = pendingReviewer()
    const svc = service([entry(0), entry(1), entry(2)], { generator, reviewer })
    const round = svc.start()
    const hintsCall = svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    resolveHints(HINTS)
    await hintsCall
    const reviewCall = svc.review(round.sessionId, REQUEST_ID, '  I ate an apple.  ', 'en', 'en')
    resolve(REVIEW)
    await expect(reviewCall).resolves.toEqual(REVIEW)
    expect(received()?.entries).toEqual([
      { entryId: UUIDS[0], term: 'word-0' },
      { entryId: UUIDS[1], term: 'word-1' },
      { entryId: UUIDS[2], term: 'word-2' }
    ])
    expect(received()?.hints).toEqual(HINTS)
    expect(received()?.answer).toBe('I ate an apple.')
    expect(received()?.explanationLanguage).toBe('en')
    expect(received()?.practiceLanguage).toBe('en')
  })

  it('rejects reviews with unknown, duplicate or contradictory word usage', async () => {
    const invalidReviews: SentencePracticeReview[] = [
      // 未知 ID
      {
        ...REVIEW,
        wordUsage: REVIEW.wordUsage.map((usage, index) =>
          index === 0 ? { ...usage, entryId: '99999999-9999-4999-8999-999999999999' } : usage
        )
      },
      // 重复 ID（缺第三个词）
      {
        ...REVIEW,
        wordUsage: [REVIEW.wordUsage[0], REVIEW.wordUsage[0], REVIEW.wordUsage[1]]
      },
      // 未使用却判正确
      {
        ...REVIEW,
        wordUsage: REVIEW.wordUsage.map((usage, index) =>
          index === 1 ? { ...usage, used: false, correct: true } : usage
        )
      },
      // 语法结论与问题列表矛盾
      {
        ...REVIEW,
        grammar: {
          correct: true,
          issues: [{ original: 'a apple', suggestion: 'an apple', explanation: '冠词' }]
        }
      }
    ]
    for (const review of invalidReviews) {
      const { generator, resolve: resolveHints } = pendingGenerator()
      const { reviewer, resolve } = pendingReviewer()
      const svc = service([entry(0), entry(1), entry(2)], { generator, reviewer })
      const round = svc.start()
      const hintsCall = svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
      resolveHints(HINTS)
      await hintsCall
      const reviewCall = svc.review(round.sessionId, REQUEST_ID, '答案', 'zh-CN', 'en')
      resolve(review)
      await expect(reviewCall).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    }
  })

  it('rejects concurrent hints and review with BUSY on the same session', async () => {
    const generatorBundle = pendingGenerator()
    const reviewerBundle = pendingReviewer()
    const svc = service([entry(0), entry(1), entry(2)], {
      generator: generatorBundle.generator,
      reviewer: reviewerBundle.reviewer
    })
    const round = svc.start()
    // 提示进行中提交点评：BUSY
    const hintsCall = svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    await expect(
      svc.review(round.sessionId, REQUEST_ID, '答案', 'zh-CN', 'en')
    ).rejects.toMatchObject({ code: 'BUSY' })
    generatorBundle.resolve(HINTS)
    await hintsCall

    // 点评进行中再次生成提示：BUSY
    const reviewCall = svc.review(round.sessionId, REQUEST_ID, '答案', 'zh-CN', 'en')
    await expect(
      svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    ).rejects.toMatchObject({ code: 'BUSY' })
    reviewerBundle.resolve(REVIEW)
    await reviewCall
  })

  it('cancels the in-flight operation by session and request id', async () => {
    const { generator, resolve } = pendingGenerator()
    const svc = service([entry(0), entry(1), entry(2)], { generator })
    const round = svc.start()
    const hintsCall = svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    // 请求 ID 不匹配时不中止
    expect(svc.cancel(round.sessionId, '55555555-5555-4555-8555-555555555555')).toBe(false)
    expect(svc.cancel(round.sessionId, REQUEST_ID)).toBe(true)
    await expect(hintsCall).rejects.toMatchObject({ code: 'CANCELLED' })
    // 取消后保留会话与单词，可对同一组单词重新生成
    const retry = svc.generateHints(
      round.sessionId,
      '66666666-6666-4666-8666-666666666666',
      'zh-CN',
      'en'
    )
    resolve(HINTS)
    await expect(retry).resolves.toEqual(HINTS)
  })

  it('closing aborts the in-flight operation and releases the session idempotently', async () => {
    const { generator } = pendingGenerator()
    const svc = service([entry(0), entry(1), entry(2)], { generator })
    const round = svc.start()
    const hintsCall = svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    expect(svc.close(round.sessionId)).toBe(true)
    await expect(hintsCall).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(
      svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    // 幂等：再次关闭返回 false
    expect(svc.close(round.sessionId)).toBe(false)
  })

  it('starting a new round aborts the previous in-flight operation', async () => {
    const { generator } = pendingGenerator()
    const svc = service([entry(0), entry(1), entry(2)], { generator })
    const first = svc.start()
    const hintsCall = svc.generateHints(first.sessionId, REQUEST_ID, 'zh-CN', 'en')
    const second = svc.start()
    await expect(hintsCall).rejects.toMatchObject({ code: 'CANCELLED' })
    // 旧会话随新一轮失效
    await expect(
      svc.generateHints(first.sessionId, REQUEST_ID, 'zh-CN', 'en')
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    expect(second.entries).toHaveLength(3)
  })

  it('times out hint generation that exceeds the total deadline', async () => {
    const { generator } = pendingGenerator()
    const svc = service([entry(0), entry(1), entry(2)], { generator, hintsTimeoutMs: 10 })
    const round = svc.start()
    await expect(
      svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('times out reviews that exceed the total deadline', async () => {
    const { generator, resolve: resolveHints } = pendingGenerator()
    const { reviewer } = pendingReviewer()
    const svc = service([entry(0), entry(1), entry(2)], {
      generator,
      reviewer,
      reviewTimeoutMs: 10
    })
    const round = svc.start()
    const hintsCall = svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    resolveHints(HINTS)
    await hintsCall
    await expect(
      svc.review(round.sessionId, REQUEST_ID, '答案', 'zh-CN', 'en')
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('keeps the round snapshot when the vocabulary changes afterwards', async () => {
    let currentEntries = [entry(0), entry(1), entry(2)]
    const { generator, resolve: resolveHints } = pendingGenerator()
    const { reviewer, received, resolve } = pendingReviewer()
    const svc = new SentencePracticeService(
      { sampleRandom: (count) => currentEntries.slice(0, count) },
      () => generator,
      () => reviewer
    )
    const round = svc.start()
    // 快照之后词库变化（甚至清空）不影响本轮提示与点评
    currentEntries = []
    const hintsCall = svc.generateHints(round.sessionId, REQUEST_ID, 'zh-CN', 'en')
    resolveHints(HINTS)
    await hintsCall
    const reviewCall = svc.review(round.sessionId, REQUEST_ID, '答案', 'zh-CN', 'en')
    resolve(REVIEW)
    await reviewCall
    expect(received()?.entries).toEqual(round.entries)
  })
})
