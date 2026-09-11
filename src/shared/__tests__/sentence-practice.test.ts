import { describe, expect, it } from 'vitest'
import {
  sentencePracticeCloseInputSchema,
  sentencePracticeCloseResultSchema,
  sentencePracticeHintsInputSchema,
  sentencePracticeHintsResultSchema,
  sentencePracticeReviewInputSchema,
  sentencePracticeReviewResultSchema,
  sentencePracticeReviewSchema,
  sentencePracticeStartInputSchema,
  sentencePracticeStartResultSchema
} from '../sentence-practice'

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'
const UUID3 = '33333333-3333-4333-8333-333333333333'

const HINTS = [
  { entryIds: [UUID], phrase: 'eat an apple', explanation: '吃一个苹果' },
  { entryIds: [UUID2], phrase: 'a bunch of bananas', explanation: '一串香蕉' },
  { entryIds: [UUID3], phrase: 'ripe cherries', explanation: '成熟的樱桃' }
]

const REVIEW = {
  wordUsage: [
    { entryId: UUID, used: true, correct: true, feedback: '使用正确。' },
    { entryId: UUID2, used: true, correct: true, feedback: '使用正确。' },
    { entryId: UUID3, used: true, correct: true, feedback: '使用正确。' }
  ],
  fluency: { natural: true, feedback: '整体通顺。' },
  grammar: { correct: true, issues: [] },
  summary: '全部正确。',
  revisedAnswer: null
}

describe('sentence practice protocol', () => {
  it('accepts a consistent start result and rejects inconsistent counts', () => {
    const ok = {
      status: 'ok',
      sessionId: UUID,
      actualCount: 3,
      entries: [
        { entryId: UUID, term: 'apple' },
        { entryId: UUID2, term: 'banana' },
        { entryId: UUID3, term: 'cherry' }
      ]
    }
    expect(sentencePracticeStartResultSchema.safeParse(ok).success).toBe(true)
    // actualCount 与 entries 数量不一致
    expect(sentencePracticeStartResultSchema.safeParse({ ...ok, actualCount: 2 }).success).toBe(
      false
    )
    // 空词库：0 个词条合法，由页面展示空状态
    expect(
      sentencePracticeStartResultSchema.safeParse({ ...ok, actualCount: 0, entries: [] }).success
    ).toBe(true)
    // 超过 3 个词条属于协议违规
    expect(
      sentencePracticeStartResultSchema.safeParse({
        ...ok,
        actualCount: 4,
        entries: [...ok.entries, { entryId: UUID, term: 'dup' }]
      }).success
    ).toBe(false)
  })

  it('requires a request id uuid for start and hints', () => {
    expect(sentencePracticeStartInputSchema.safeParse({ requestId: UUID }).success).toBe(true)
    expect(sentencePracticeStartInputSchema.safeParse({ requestId: 'apple' }).success).toBe(false)
    expect(sentencePracticeStartInputSchema.safeParse({}).success).toBe(false)
    expect(
      sentencePracticeHintsInputSchema.safeParse({ requestId: UUID, sessionId: UUID2 }).success
    ).toBe(true)
    expect(sentencePracticeHintsInputSchema.safeParse({ requestId: UUID }).success).toBe(false)
  })

  it('bounds hint results to 3-6 hints that together cover all three words', () => {
    const ok = { status: 'ok', hints: HINTS }
    expect(sentencePracticeHintsResultSchema.safeParse(ok).success).toBe(true)
    // 少于 3 条
    expect(
      sentencePracticeHintsResultSchema.safeParse({ status: 'ok', hints: HINTS.slice(0, 2) })
        .success
    ).toBe(false)
    // 多于 6 条
    expect(
      sentencePracticeHintsResultSchema.safeParse({
        status: 'ok',
        hints: [...HINTS, ...HINTS, ...HINTS, HINTS[0]]
      }).success
    ).toBe(false)
    // 合计未覆盖全部词条（第三个词缺失）
    expect(
      sentencePracticeHintsResultSchema.safeParse({
        status: 'ok',
        hints: [HINTS[0], HINTS[0], HINTS[1]]
      }).success
    ).toBe(false)
    // 单条提示内重复 ID 非法
    expect(
      sentencePracticeHintsResultSchema.safeParse({
        status: 'ok',
        hints: [{ ...HINTS[0], entryIds: [UUID, UUID] }, HINTS[1], HINTS[2]]
      }).success
    ).toBe(false)
    // 空文本或超长短语非法
    expect(
      sentencePracticeHintsResultSchema.safeParse({
        status: 'ok',
        hints: [{ ...HINTS[0], phrase: '   ' }, HINTS[1], HINTS[2]]
      }).success
    ).toBe(false)
    expect(
      sentencePracticeHintsResultSchema.safeParse({
        status: 'ok',
        hints: [{ ...HINTS[0], phrase: 'a'.repeat(201) }, HINTS[1], HINTS[2]]
      }).success
    ).toBe(false)
  })

  it('requires a non-empty trimmed answer bounded to 2000 characters', () => {
    const base = { requestId: UUID, sessionId: UUID2 }
    expect(
      sentencePracticeReviewInputSchema.safeParse({ ...base, answer: '  Apple pie. ' }).success
    ).toBe(true)
    for (const answer of ['', '   ', 'a'.repeat(2001)]) {
      expect(sentencePracticeReviewInputSchema.safeParse({ ...base, answer }).success).toBe(false)
    }
  })

  it('rejects reviews with duplicate, forged or inconsistent word usage', () => {
    // 未使用却判正确属于自相矛盾
    expect(
      sentencePracticeReviewSchema.safeParse({
        ...REVIEW,
        wordUsage: REVIEW.wordUsage.map((usage, index) =>
          index === 0 ? { ...usage, used: false, correct: true } : usage
        )
      }).success
    ).toBe(false)
    expect(
      sentencePracticeReviewSchema.safeParse({
        ...REVIEW,
        wordUsage: REVIEW.wordUsage.map((usage, index) =>
          index === 0 ? { ...usage, used: false, correct: false } : usage
        )
      }).success
    ).toBe(true)
    // 词条数量不足 3
    expect(
      sentencePracticeReviewSchema.safeParse({ ...REVIEW, wordUsage: REVIEW.wordUsage.slice(0, 2) })
        .success
    ).toBe(false)
    // 重复 ID
    expect(
      sentencePracticeReviewSchema.safeParse({
        ...REVIEW,
        wordUsage: [REVIEW.wordUsage[0], REVIEW.wordUsage[0], REVIEW.wordUsage[1]]
      }).success
    ).toBe(false)
  })

  it('rejects reviews where the grammar verdict contradicts the issues', () => {
    // 语法正确却携带问题
    expect(
      sentencePracticeReviewSchema.safeParse({
        ...REVIEW,
        grammar: {
          correct: true,
          issues: [{ original: 'a apple', suggestion: 'an apple', explanation: '冠词' }]
        }
      }).success
    ).toBe(false)
    // 语法错误却没有具体问题
    expect(
      sentencePracticeReviewSchema.safeParse({ ...REVIEW, grammar: { correct: false, issues: [] } })
        .success
    ).toBe(false)
    // 语法错误且给出问题：合法（revisedAnswer 提供改写）
    expect(
      sentencePracticeReviewSchema.safeParse({
        ...REVIEW,
        grammar: {
          correct: false,
          issues: [{ original: 'a apple', suggestion: 'an apple', explanation: '冠词' }]
        },
        revisedAnswer: 'An apple a day.'
      }).success
    ).toBe(true)
    // 改写为空字符串非法（要么 null 要么非空）
    expect(sentencePracticeReviewSchema.safeParse({ ...REVIEW, revisedAnswer: '' }).success).toBe(
      false
    )
  })

  it('wraps the review into a status union result', () => {
    expect(
      sentencePracticeReviewResultSchema.safeParse({ status: 'ok', review: REVIEW }).success
    ).toBe(true)
    expect(sentencePracticeReviewResultSchema.safeParse({ status: 'ok' }).success).toBe(false)
    expect(
      sentencePracticeReviewResultSchema.safeParse({
        status: 'error',
        error: { code: 'CANCELLED' }
      }).success
    ).toBe(true)
  })

  it('requires session and request ids for cancel and close', () => {
    expect(sentencePracticeCloseInputSchema.safeParse({ sessionId: UUID }).success).toBe(true)
    expect(sentencePracticeCloseInputSchema.safeParse({}).success).toBe(false)
    expect(
      sentencePracticeCloseResultSchema.safeParse({ status: 'ok', closed: false }).success
    ).toBe(true)
    // cancel 需要会话与请求 ID
    expect(
      sentencePracticeHintsInputSchema.safeParse({ requestId: UUID, sessionId: UUID2 }).success
    ).toBe(true)
  })
})
