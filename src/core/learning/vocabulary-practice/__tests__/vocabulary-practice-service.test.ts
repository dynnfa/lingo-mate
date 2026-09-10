import { describe, expect, it, vi } from 'vitest'
import type { VocabularyEntry } from '../../../../shared/vocabulary'
import type {
  PracticeReviewOutcome,
  VocabularyPracticeReviewer
} from '../vocabulary-practice-reviewer'
import { VocabularyPracticeService } from '../vocabulary-practice-service'
import { VocabularyPracticeError } from '../parse-vocabulary-practice-input'

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
]

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
  reviewer: VocabularyPracticeReviewer
): VocabularyPracticeService {
  return new VocabularyPracticeService(
    { sampleRandom: (count) => entries.slice(0, count) },
    () => reviewer,
    5_000
  )
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
    const svc = new VocabularyPracticeService({ sampleRandom: sample }, createReviewer)
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
    await expect(svc.review(round.sessionId, [answer(UUIDS[0])], 'zh-CN')).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    // 重复
    await expect(
      svc.review(round.sessionId, [answer(UUIDS[0]), answer(UUIDS[0])], 'zh-CN')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    // 非本轮 ID
    await expect(
      svc.review(round.sessionId, [answer(UUIDS[0]), answer(UUIDS[2])], 'zh-CN')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    // 空释义
    await expect(
      svc.review(round.sessionId, [answer(UUIDS[0]), { entryId: UUIDS[1], meaning: '  ' }], 'zh-CN')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('builds trusted review entries from the snapshot and returns the outcome', async () => {
    const { reviewer, received, resolve } = pendingReviewer()
    const nullMeaning = entry(1, { meaning: null })
    const svc = service([entry(0), nullMeaning], reviewer)
    const round = svc.start(2)
    const review = svc.review(
      round.sessionId,
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
    const first = svc.review(round.sessionId, [{ entryId: UUIDS[0], meaning: '答案' }], 'zh-CN')
    await expect(
      svc.review(round.sessionId, [{ entryId: UUIDS[0], meaning: '答案' }], 'zh-CN')
    ).rejects.toMatchObject({ code: 'BUSY' })
    resolve(OUTCOME)
    await expect(first).resolves.toBe(OUTCOME)
  })

  it('cancels the in-flight review and keeps the session reusable', async () => {
    const { reviewer } = pendingReviewer()
    const svc = service([entry(0)], reviewer)
    const round = svc.start(1)
    const review = svc.review(round.sessionId, [{ entryId: UUIDS[0], meaning: '答案' }], 'zh-CN')
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
      [{ entryId: first.entries[0].entryId, meaning: '答案' }],
      'zh-CN'
    )
    const second = svc.start(2)
    await expect(review).rejects.toMatchObject({ code: 'CANCELLED' })
    // 旧会话随新一轮失效
    await expect(
      svc.review(first.sessionId, [{ entryId: first.entries[0].entryId, meaning: '答案' }], 'zh-CN')
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    expect(second.entries).toHaveLength(2)
  })

  it('times out a review that exceeds the total deadline', async () => {
    const { reviewer } = pendingReviewer()
    const svc = new VocabularyPracticeService(
      { sampleRandom: (count) => [entry(0)].slice(0, count) },
      () => reviewer,
      10
    )
    const round = svc.start(1)
    await expect(
      svc.review(round.sessionId, [{ entryId: UUIDS[0], meaning: '答案' }], 'zh-CN')
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})
