import { describe, expect, it } from 'vitest'
import {
  vocabularyPracticeCancelInputSchema,
  vocabularyPracticeReviewInputSchema,
  vocabularyPracticeReviewResultSchema,
  vocabularyPracticeStartInputSchema,
  vocabularyPracticeStartResultSchema
} from '../vocabulary-practice'

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'

describe('vocabulary practice protocol', () => {
  it('accepts a consistent start result and rejects inconsistent counts', () => {
    const ok = {
      status: 'ok',
      sessionId: UUID,
      requestedCount: 10,
      actualCount: 3,
      entries: [
        { entryId: UUID, term: 'apple' },
        { entryId: UUID2, term: 'banana' }
      ]
    }
    // actualCount 与 entries 数量不一致（3 ≠ 2）
    expect(vocabularyPracticeStartResultSchema.safeParse(ok).success).toBe(false)
    expect(vocabularyPracticeStartResultSchema.safeParse({ ...ok, actualCount: 2 }).success).toBe(
      true
    )
    // 空词库：0 个词条合法，由页面展示空状态
    expect(
      vocabularyPracticeStartResultSchema.safeParse({
        ...ok,
        actualCount: 0,
        entries: []
      }).success
    ).toBe(true)
    // 实际数量超过请求数量属于协议违规
    expect(
      vocabularyPracticeStartResultSchema.safeParse({
        ...ok,
        actualCount: 2,
        requestedCount: 1
      }).success
    ).toBe(false)
  })

  it('bounds the start count to integers 1-50', () => {
    expect(
      vocabularyPracticeStartInputSchema.safeParse({ requestId: UUID, count: 10 }).success
    ).toBe(true)
    for (const count of [0, -1, 51, 1.5, '10', NaN]) {
      expect(vocabularyPracticeStartInputSchema.safeParse({ requestId: UUID, count }).success).toBe(
        false
      )
    }
  })

  it('requires non-empty trimmed answers bounded to 2000 characters', () => {
    expect(
      vocabularyPracticeReviewInputSchema.safeParse({
        requestId: UUID,
        sessionId: UUID2,
        answers: [{ entryId: UUID, meaning: '一种水果' }]
      }).success
    ).toBe(true)
    for (const meaning of ['', '   ', 'a'.repeat(2001)]) {
      expect(
        vocabularyPracticeReviewInputSchema.safeParse({
          requestId: UUID,
          sessionId: UUID2,
          answers: [{ entryId: UUID, meaning }]
        }).success
      ).toBe(false)
    }
    // 空答案数组不允许：至少要提交一个答案
    expect(
      vocabularyPracticeReviewInputSchema.safeParse({
        requestId: UUID,
        sessionId: UUID2,
        answers: []
      }).success
    ).toBe(false)
  })

  it('rejects review results where the verdict contradicts the marks', () => {
    const base = { status: 'ok', summary: '存在错误。' }
    const marks = [{ entryId: UUID, field: 'meaning' as const, reason: '释义不匹配' }]
    expect(
      vocabularyPracticeReviewResultSchema.safeParse({
        ...base,
        verdict: 'has_errors',
        marks
      }).success
    ).toBe(true)
    expect(
      vocabularyPracticeReviewResultSchema.safeParse({
        ...base,
        verdict: 'all_correct',
        marks
      }).success
    ).toBe(false)
    expect(
      vocabularyPracticeReviewResultSchema.safeParse({
        ...base,
        verdict: 'all_correct',
        marks: []
      }).success
    ).toBe(true)
    // 摘要为空或超长非法
    expect(
      vocabularyPracticeReviewResultSchema.safeParse({
        status: 'ok',
        verdict: 'all_correct',
        summary: '',
        marks: []
      }).success
    ).toBe(false)
  })

  it('only accepts session UUIDs for cancel', () => {
    expect(vocabularyPracticeCancelInputSchema.safeParse({ sessionId: UUID }).success).toBe(true)
    expect(vocabularyPracticeCancelInputSchema.safeParse({ sessionId: 'apple' }).success).toBe(
      false
    )
    expect(vocabularyPracticeCancelInputSchema.safeParse({}).success).toBe(false)
  })
})
