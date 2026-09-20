import { describe, expect, it, vi } from 'vitest'
import type { VocabularyEntry } from '../../../../shared/vocabulary'
import type {
  PracticeReviewOutcome,
  VocabularyPracticeReviewer
} from '../vocabulary-practice-reviewer'
import type { VocabularyMistakeRecord } from '../vocabulary-mistake-repository'
import { VocabularyPracticeService } from '../vocabulary-practice-service'
import { VocabularyPracticeError } from '../parse-vocabulary-practice-input'

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
]
const REQUEST_ID = '44444444-4444-4444-8444-444444444444'
const REQUEST_ID_2 = '55555555-5555-4555-8555-555555555555'
const FIXED_TIME = new Date('2026-09-20T12:00:00.000Z')

function entry(index: number, overrides: Partial<VocabularyEntry> = {}): VocabularyEntry {
  return {
    id: UUIDS[index],
    term: `word-${index}`,
    phonetic: null,
    meaning: `释义-${index}`,
    concept: null,
    exampleSentences: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    ...overrides
  }
}

// 可控的假审查器：挂起 review 让调用方决定完成时机，并记录收到的条目。
function pendingReviewer(): {
  reviewer: VocabularyPracticeReviewer
  received: () => Array<{ entryId: string; referenceMeaning: string | null }>
  resolve: (outcome: PracticeReviewOutcome) => void
} {
  let receivedInput: Parameters<VocabularyPracticeReviewer['review']>[0] | undefined
  let resolveReview!: (outcome: PracticeReviewOutcome) => void
  const review = new Promise<PracticeReviewOutcome>((resolve) => {
    resolveReview = resolve
  })
  const reviewer: VocabularyPracticeReviewer = {
    async review(input) {
      receivedInput = input
      return review
    }
  }
  return {
    reviewer,
    received: () => receivedInput?.entries ?? [],
    resolve: resolveReview
  }
}

function service(
  entries: VocabularyEntry[],
  reviewer: VocabularyPracticeReviewer,
  extra: {
    mistakes?: { saveBatch(records: VocabularyMistakeRecord[]): void }
    totalReviewTimeoutMs?: number
  } = {}
): VocabularyPracticeService {
  return new VocabularyPracticeService(
    { sampleRandom: (count) => entries.slice(0, count) },
    () => reviewer,
    extra.mistakes ?? { saveBatch: () => {} },
    extra.totalReviewTimeoutMs ?? 5_000,
    () => FIXED_TIME
  )
}

// 可控的错题仓储：记录保存批次，可注入指定次数的写入失败；
// 重放按 (review_id, entry_id) 幂等去重，模拟数据库唯一约束。
function mistakeSink(failures = 0): {
  saved: VocabularyMistakeRecord[]
  saveBatch: (records: VocabularyMistakeRecord[]) => void
} {
  const saved: VocabularyMistakeRecord[] = []
  let remainingFailures = failures
  return {
    saved,
    saveBatch(records) {
      if (remainingFailures > 0) {
        remainingFailures -= 1
        throw new Error('disk unavailable')
      }
      for (const record of records) {
        if (
          !saved.some((row) => row.reviewId === record.reviewId && row.entryId === record.entryId)
        )
          saved.push(record)
      }
    }
  }
}

// 按词条顺序生成答案，便于逐个覆盖错误释义。
function answersFor(
  termCount: number,
  meanings: string[]
): Array<{ entryId: string; meaning: string }> {
  return Array.from({ length: termCount }, (_, index) => ({
    entryId: UUIDS[index],
    meaning: meanings[index] ?? '答案'
  }))
}

const OUTCOME: PracticeReviewOutcome = {
  verdict: 'all_correct',
  summary: '全部正确。',
  marks: []
}

describe('vocabulary practice service', () => {
  it('rejects counts outside 1-50 before touching the repository', () => {
    const sample = vi.fn()
    const createReviewer = (): VocabularyPracticeReviewer => {
      throw new Error('reviewer must not be created')
    }
    const svc = new VocabularyPracticeService({ sampleRandom: sample }, createReviewer, {
      saveBatch: () => {}
    })
    for (const count of [0, -1, 51, 2.5, NaN]) {
      expect(() => svc.start(count)).toThrow(VocabularyPracticeError)
    }
    expect(sample).not.toHaveBeenCalled()
  })

  it('starts with all entries when the vocabulary is smaller than requested', () => {
    const { reviewer } = pendingReviewer()
    const svc = service([entry(0), entry(1)], reviewer)
    const round = svc.start(10)
    expect(round.requestedCount).toBe(10)
    expect(round.entries).toHaveLength(2)
    expect(round.entries[0]).toEqual({ entryId: UUIDS[0], term: 'word-0' })
  })

  it('reports an empty round for an empty vocabulary', () => {
    const { reviewer } = pendingReviewer()
    const svc = service([], reviewer)
    const round = svc.start(5)
    expect(round.entries).toEqual([])
  })

  it('rejects answers that miss, duplicate or forge snapshot ids', async () => {
    const { reviewer } = pendingReviewer()
    const svc = service([entry(0), entry(1)], reviewer)
    const round = svc.start(2)
    const answer = (id: string): { entryId: string; meaning: string } => ({
      entryId: id,
      meaning: '答案'
    })
    // 漏项
    await expect(
      svc.review(round.sessionId, REQUEST_ID, [answer(UUIDS[0])], 'zh-CN')
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    // 重复
    await expect(
      svc.review(round.sessionId, REQUEST_ID, [answer(UUIDS[0]), answer(UUIDS[0])], 'zh-CN')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    // 非本轮 ID
    await expect(
      svc.review(round.sessionId, REQUEST_ID, [answer(UUIDS[0]), answer(UUIDS[2])], 'zh-CN')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    // 空释义
    await expect(
      svc.review(
        round.sessionId,
        REQUEST_ID,
        [answer(UUIDS[0]), { entryId: UUIDS[1], meaning: '  ' }],
        'zh-CN'
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('builds trusted review entries from the snapshot and returns the outcome', async () => {
    const { reviewer, received, resolve } = pendingReviewer()
    const nullMeaning = entry(1, { meaning: null })
    const svc = service([entry(0), nullMeaning], reviewer)
    const round = svc.start(2)
    const review = svc.review(
      round.sessionId,
      REQUEST_ID,
      [
        { entryId: UUIDS[0], meaning: '  苹果  ' },
        { entryId: UUIDS[1], meaning: '香蕉' }
      ],
      'en'
    )
    resolve(OUTCOME)
    await expect(review).resolves.toBe(OUTCOME)
    // 提交含义去除首尾空白；参考释义来自快照，null 保留为 null
    expect(received()).toEqual([
      { entryId: UUIDS[0], term: 'word-0', submittedMeaning: '苹果', referenceMeaning: '释义-0' },
      { entryId: UUIDS[1], term: 'word-1', submittedMeaning: '香蕉', referenceMeaning: null }
    ])
  })

  it('rejects concurrent reviews with BUSY', async () => {
    const { reviewer, resolve } = pendingReviewer()
    const svc = service([entry(0)], reviewer)
    const round = svc.start(1)
    const first = svc.review(
      round.sessionId,
      REQUEST_ID,
      [{ entryId: UUIDS[0], meaning: '答案' }],
      'zh-CN'
    )
    await expect(
      svc.review(round.sessionId, REQUEST_ID, [{ entryId: UUIDS[0], meaning: '答案' }], 'zh-CN')
    ).rejects.toMatchObject({ code: 'BUSY' })
    resolve(OUTCOME)
    await expect(first).resolves.toBe(OUTCOME)
  })

  it('cancels the in-flight review and keeps the session reusable', async () => {
    const { reviewer } = pendingReviewer()
    const svc = service([entry(0)], reviewer)
    const round = svc.start(1)
    const review = svc.review(
      round.sessionId,
      REQUEST_ID,
      [{ entryId: UUIDS[0], meaning: '答案' }],
      'zh-CN'
    )
    expect(svc.cancel(round.sessionId)).toBe(true)
    await expect(review).rejects.toMatchObject({ code: 'CANCELLED' })
    // 空闲时取消返回 false（幂等）
    expect(svc.cancel(round.sessionId)).toBe(false)
  })

  it('starting a new round aborts the previous in-flight review', async () => {
    const { reviewer } = pendingReviewer()
    const svc = service([entry(0), entry(1)], reviewer)
    const first = svc.start(1)
    const review = svc.review(
      first.sessionId,
      REQUEST_ID,
      [{ entryId: first.entries[0].entryId, meaning: '答案' }],
      'zh-CN'
    )
    const second = svc.start(2)
    await expect(review).rejects.toMatchObject({ code: 'CANCELLED' })
    // 旧会话随新一轮失效
    await expect(
      svc.review(
        first.sessionId,
        REQUEST_ID,
        [{ entryId: first.entries[0].entryId, meaning: '答案' }],
        'zh-CN'
      )
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    expect(second.entries).toHaveLength(2)
  })

  it('times out a review that exceeds the total deadline', async () => {
    const { reviewer } = pendingReviewer()
    const svc = new VocabularyPracticeService(
      { sampleRandom: (count) => [entry(0)].slice(0, count) },
      () => reviewer,
      { saveBatch: () => {} },
      10
    )
    const round = svc.start(1)
    await expect(
      svc.review(round.sessionId, REQUEST_ID, [{ entryId: UUIDS[0], meaning: '答案' }], 'zh-CN')
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})

describe('vocabulary practice mistake collection', () => {
  const ERRORS_OUTCOME: PracticeReviewOutcome = {
    verdict: 'has_errors',
    summary: '两处释义有误。',
    marks: [
      { entryId: UUIDS[0], field: 'meaning', reason: '释义不符' },
      { entryId: UUIDS[2], field: 'meaning', reason: '释义不符' }
    ]
  }

  const ERRORS_OUTCOME_SINGLE: PracticeReviewOutcome = {
    verdict: 'has_errors',
    summary: '一处释义有误。',
    marks: [{ entryId: UUIDS[0], field: 'meaning', reason: '释义不符' }]
  }

  // 立即完成审查的审查器：记录调用次数并可控制结果。
  function instantReviewer(
    outcome: PracticeReviewOutcome = ERRORS_OUTCOME,
    error?: Error
  ): { reviewer: VocabularyPracticeReviewer; calls: () => number } {
    let calls = 0
    const reviewer: VocabularyPracticeReviewer = {
      async review() {
        calls += 1
        if (error) throw error
        return outcome
      }
    }
    return { reviewer, calls: () => calls }
  }

  it('saves only the marked entries with their submitted meanings and time', async () => {
    const { reviewer } = instantReviewer()
    const sink = mistakeSink()
    const svc = service([entry(0), entry(1), entry(2)], reviewer, { mistakes: sink })
    const round = svc.start(3)
    await svc.review(
      round.sessionId,
      REQUEST_ID,
      answersFor(3, ['答错一', '正确', '答错三']),
      'zh-CN'
    )
    expect(sink.saved).toHaveLength(2)
    for (const record of sink.saved) {
      expect(record.reviewId).toBe(REQUEST_ID)
      expect(record.createdAt).toBe(FIXED_TIME.toISOString())
    }
    expect(sink.saved.map((record) => record.entryId)).toEqual([UUIDS[0], UUIDS[2]])
    expect(sink.saved.map((record) => record.term)).toEqual(['word-0', 'word-2'])
    expect(sink.saved.map((record) => record.submittedMeaning)).toEqual(['答错一', '答错三'])
  })

  it('saves nothing when every answer is correct', async () => {
    const { reviewer } = instantReviewer(OUTCOME)
    const sink = mistakeSink()
    const svc = service([entry(0)], reviewer, { mistakes: sink })
    const round = svc.start(1)
    await svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['对的']), 'zh-CN')
    expect(sink.saved).toHaveLength(0)
  })

  it('treats contradictory or foreign marks as invalid analysis without saving', async () => {
    const contradictory: PracticeReviewOutcome = {
      verdict: 'has_errors',
      summary: '有错。',
      marks: []
    }
    const foreign: PracticeReviewOutcome = {
      verdict: 'has_errors',
      summary: '有错。',
      marks: [
        { entryId: '99999999-9999-4999-8999-999999999999', field: 'meaning', reason: '不在本轮' }
      ]
    }
    const duplicated: PracticeReviewOutcome = {
      verdict: 'has_errors',
      summary: '有错。',
      marks: [
        { entryId: UUIDS[0], field: 'meaning', reason: '一次' },
        { entryId: UUIDS[0], field: 'meaning', reason: '两次' }
      ]
    }
    const allCorrectWithMarks: PracticeReviewOutcome = {
      verdict: 'all_correct',
      summary: '全对。',
      marks: [{ entryId: UUIDS[0], field: 'meaning', reason: '矛盾' }]
    }
    for (const outcome of [contradictory, foreign, duplicated, allCorrectWithMarks]) {
      const { reviewer } = instantReviewer(outcome)
      const sink = mistakeSink()
      const svc = service([entry(0)], reviewer, { mistakes: sink })
      const round = svc.start(1)
      await expect(
        svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['答案']), 'zh-CN')
      ).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
      expect(sink.saved).toHaveLength(0)
    }
  })

  it('persists nothing when the review fails, is cancelled, or is replaced by a new round', async () => {
    // 模型失败
    const { reviewer: failing, calls: failingCalls } = instantReviewer(
      ERRORS_OUTCOME,
      new VocabularyPracticeError('MODEL_ERROR')
    )
    let sink = mistakeSink()
    let svc = service([entry(0)], failing, { mistakes: sink })
    let round = svc.start(1)
    await expect(
      svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['错']), 'zh-CN')
    ).rejects.toMatchObject({ code: 'MODEL_ERROR' })
    expect(sink.saved).toHaveLength(0)

    // 取消竞争：在途审查被取消后不落库
    const pending = pendingReviewer()
    sink = mistakeSink()
    svc = service([entry(0)], pending.reviewer, { mistakes: sink })
    round = svc.start(1)
    const cancelled = svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['错']), 'zh-CN')
    svc.cancel(round.sessionId)
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' })
    // 取消后迟到的模型结果（审查器仍挂起）不再触发保存
    pending.resolve(ERRORS_OUTCOME)
    await Promise.resolve()
    expect(sink.saved).toHaveLength(0)

    // 切换新一轮替换未完成审查
    const replaced = pendingReviewer()
    sink = mistakeSink()
    svc = service([entry(0), entry(1)], replaced.reviewer, { mistakes: sink })
    round = svc.start(1)
    const stale = svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['错']), 'zh-CN')
    svc.start(2)
    await expect(stale).rejects.toMatchObject({ code: 'CANCELLED' })
    replaced.resolve(ERRORS_OUTCOME)
    await Promise.resolve()
    expect(sink.saved).toHaveLength(0)
    expect(failingCalls()).toBe(1)
  })

  it('retries only the save when the same submission is resubmitted after a storage failure', async () => {
    const { reviewer, calls } = instantReviewer(ERRORS_OUTCOME_SINGLE)
    const sink = mistakeSink(1)
    const svc = service([entry(0)], reviewer, { mistakes: sink })
    const round = svc.start(1)
    await expect(
      svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['错']), 'zh-CN')
    ).rejects.toMatchObject({ code: 'STORAGE_FAILED' })
    expect(calls()).toBe(1)
    expect(sink.saved).toHaveLength(0)

    // 重试复用同一 requestId 与答案：不再次调用模型，仅重试保存
    await expect(
      svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['错']), 'zh-CN')
    ).resolves.toEqual(ERRORS_OUTCOME_SINGLE)
    expect(calls()).toBe(1)
    expect(sink.saved).toHaveLength(1)

    // 重复 IPC 重放：仍不重复调用模型，也不重复计数
    await expect(
      svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['错']), 'zh-CN')
    ).resolves.toEqual(ERRORS_OUTCOME_SINGLE)
    expect(calls()).toBe(1)
    expect(sink.saved).toHaveLength(1)
  })

  it('rejects the same requestId carrying different answers', async () => {
    const { reviewer, calls } = instantReviewer(ERRORS_OUTCOME_SINGLE)
    const sink = mistakeSink(1)
    const svc = service([entry(0)], reviewer, { mistakes: sink })
    const round = svc.start(1)
    await expect(
      svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['错']), 'zh-CN')
    ).rejects.toMatchObject({ code: 'STORAGE_FAILED' })
    // 相同 ID 携带不同答案：拒绝且不触发新的模型审查
    await expect(
      svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['改过的错']), 'zh-CN')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(calls()).toBe(1)
    expect(sink.saved).toHaveLength(0)
    // 原答案重试仍可用缓存结果
    await expect(
      svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['错']), 'zh-CN')
    ).resolves.toEqual(ERRORS_OUTCOME_SINGLE)
  })

  it('treats an edited resubmission with a new requestId as a fresh review', async () => {
    const { reviewer, calls } = instantReviewer(ERRORS_OUTCOME_SINGLE)
    const sink = mistakeSink()
    const svc = service([entry(0)], reviewer, { mistakes: sink })
    const round = svc.start(1)
    await svc.review(round.sessionId, REQUEST_ID, answersFor(1, ['第一次错']), 'zh-CN')
    await svc.review(round.sessionId, REQUEST_ID_2, answersFor(1, ['第二次错']), 'zh-CN')
    expect(calls()).toBe(2)
    expect(sink.saved.map((record) => record.submittedMeaning)).toEqual(['第一次错', '第二次错'])
    expect(sink.saved.map((record) => record.reviewId)).toEqual([REQUEST_ID, REQUEST_ID_2])
  })
})
