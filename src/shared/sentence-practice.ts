import { z } from 'zod'

// ── 造句练习 IPC 协议 ──
// 每轮固定抽取 3 个词条，模型生成 phrase 提示后由用户造句，再提交
// 模型点评。会话、提示与点评只保存在内存，不新增持久化数据。

export const SENTENCE_PRACTICE_WORD_COUNT = 3
export const SENTENCE_PRACTICE_HINT_COUNT_MIN = 3
export const SENTENCE_PRACTICE_HINT_COUNT_MAX = 6
export const SENTENCE_PRACTICE_ENTRY_IDS_MAX = SENTENCE_PRACTICE_WORD_COUNT
export const SENTENCE_PRACTICE_TERM_MAX_LENGTH = 4000
export const SENTENCE_PRACTICE_PHRASE_MAX_LENGTH = 200
export const SENTENCE_PRACTICE_HINT_EXPLANATION_MAX_LENGTH = 500
export const SENTENCE_PRACTICE_ANSWER_MIN_LENGTH = 1
export const SENTENCE_PRACTICE_ANSWER_MAX_LENGTH = 2000
export const SENTENCE_PRACTICE_FEEDBACK_MAX_LENGTH = 1000
export const SENTENCE_PRACTICE_ISSUE_TEXT_MAX_LENGTH = 2000
export const SENTENCE_PRACTICE_ISSUE_EXPLANATION_MAX_LENGTH = 1000
export const SENTENCE_PRACTICE_ISSUES_MAX = 10
export const SENTENCE_PRACTICE_SUMMARY_MAX_LENGTH = 2000
export const SENTENCE_PRACTICE_REVISED_ANSWER_MAX_LENGTH = 4000

export const SENTENCE_PRACTICE_CHANNELS = {
  start: 'sentence-practice:start',
  hints: 'sentence-practice:hints',
  review: 'sentence-practice:review',
  cancel: 'sentence-practice:cancel',
  close: 'sentence-practice:close'
} as const

export const sentencePracticeErrorCodeSchema = z.enum([
  'AGENT_UNAVAILABLE',
  'AGENT_PROTOCOL_ERROR',
  'AGENT_LIMIT',
  'AGENT_HOST_ERROR',
  'UNTRUSTED_SOURCE',
  'INVALID_INPUT',
  'SESSION_NOT_FOUND',
  'BUSY',
  'MODEL_NOT_CONFIGURED',
  'CREDENTIAL_DECRYPT_FAILED',
  'MODEL_ERROR',
  'INVALID_ANALYSIS',
  'TIMEOUT',
  'CANCELLED',
  'STORAGE_FAILED',
  'UNKNOWN_ERROR'
])
export type SentencePracticeErrorCode = z.infer<typeof sentencePracticeErrorCodeSchema>
export const sentencePracticeErrorSchema = z.strictObject({
  code: sentencePracticeErrorCodeSchema
})
export type SentencePracticeError = z.infer<typeof sentencePracticeErrorSchema>

// 开始输入：requestId 便于关联调用方日志；抽取数量固定为 3，不接收参数。
export const sentencePracticeStartInputSchema = z.strictObject({
  requestId: z.uuid()
})
export type SentencePracticeStartInput = z.input<typeof sentencePracticeStartInputSchema>

// 词条只暴露练习需要的身份与单词：参考释义留在 Core 内部，不预填答案。
export const sentencePracticeEntrySchema = z.strictObject({
  entryId: z.uuid(),
  term: z.string().min(1).max(SENTENCE_PRACTICE_TERM_MAX_LENGTH)
})
export type SentencePracticeEntry = z.infer<typeof sentencePracticeEntrySchema>

export const sentencePracticeStartResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('ok'),
      sessionId: z.uuid(),
      // 词库不足 3 个时返回全部可用词条；空词库为 0，且不发起模型调用。
      actualCount: z.number().int().min(0).max(SENTENCE_PRACTICE_WORD_COUNT),
      entries: z.array(sentencePracticeEntrySchema).max(SENTENCE_PRACTICE_WORD_COUNT)
    }),
    z.strictObject({ status: z.literal('error'), error: sentencePracticeErrorSchema })
  ])
  .superRefine((result, context) => {
    if (result.status === 'error') return
    if (result.actualCount !== result.entries.length)
      context.addIssue({ code: 'custom', message: 'Inconsistent practice start result' })
  })
export type SentencePracticeStartResult = z.infer<typeof sentencePracticeStartResultSchema>

// 提示输入：对该会话的当前词条生成（或失败后重新生成）phrase 提示。
export const sentencePracticeHintsInputSchema = z.strictObject({
  requestId: z.uuid(),
  sessionId: z.uuid()
})
export type SentencePracticeHintsInput = z.input<typeof sentencePracticeHintsInputSchema>

// 单条提示：entryIds 指向该提示关联的词条；phrase 用练习语言，
// explanation 用解释语言。提示只在满 3 词的轮次存在，合计覆盖全部词条。
export const sentencePracticeHintSchema = z.strictObject({
  entryIds: z
    .array(z.uuid())
    .min(1)
    .max(SENTENCE_PRACTICE_ENTRY_IDS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate entry ids in one hint'),
  phrase: z.string().trim().min(1).max(SENTENCE_PRACTICE_PHRASE_MAX_LENGTH),
  explanation: z.string().trim().min(1).max(SENTENCE_PRACTICE_HINT_EXPLANATION_MAX_LENGTH)
})
export type SentencePracticeHint = z.infer<typeof sentencePracticeHintSchema>

export const sentencePracticeHintsResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('ok'),
      hints: z
        .array(sentencePracticeHintSchema)
        .min(SENTENCE_PRACTICE_HINT_COUNT_MIN)
        .max(SENTENCE_PRACTICE_HINT_COUNT_MAX)
    }),
    z.strictObject({ status: z.literal('error'), error: sentencePracticeErrorSchema })
  ])
  .superRefine((result, context) => {
    if (result.status === 'error') return
    const covered = new Set(result.hints.flatMap((hint) => hint.entryIds))
    if (covered.size !== SENTENCE_PRACTICE_WORD_COUNT)
      context.addIssue({ code: 'custom', message: 'Hints do not cover all practice words' })
  })
export type SentencePracticeHintsResult = z.infer<typeof sentencePracticeHintsResultSchema>

// 点评输入：Renderer 只提交答案；Core 按 sessionId 找回快照补齐单词与提示。
export const sentencePracticeReviewInputSchema = z.strictObject({
  requestId: z.uuid(),
  sessionId: z.uuid(),
  answer: z
    .string()
    .trim()
    .min(SENTENCE_PRACTICE_ANSWER_MIN_LENGTH)
    .max(SENTENCE_PRACTICE_ANSWER_MAX_LENGTH)
})
export type SentencePracticeReviewInput = z.input<typeof sentencePracticeReviewInputSchema>

// 单词使用判定：used 表示是否实际使用（含合理词形变化），
// correct 表示用法是否正确；未使用的词不能判为用法正确。
export const sentencePracticeWordUsageSchema = z.strictObject({
  entryId: z.uuid(),
  used: z.boolean(),
  correct: z.boolean(),
  feedback: z.string().trim().min(1).max(SENTENCE_PRACTICE_FEEDBACK_MAX_LENGTH)
})
export type SentencePracticeWordUsage = z.infer<typeof sentencePracticeWordUsageSchema>

export const sentencePracticeGrammarIssueSchema = z.strictObject({
  original: z.string().trim().min(1).max(SENTENCE_PRACTICE_ISSUE_TEXT_MAX_LENGTH),
  suggestion: z.string().trim().min(1).max(SENTENCE_PRACTICE_ISSUE_TEXT_MAX_LENGTH),
  explanation: z.string().trim().min(1).max(SENTENCE_PRACTICE_ISSUE_EXPLANATION_MAX_LENGTH)
})
export type SentencePracticeGrammarIssue = z.infer<typeof sentencePracticeGrammarIssueSchema>

export const sentencePracticeReviewSchema = z
  .strictObject({
    wordUsage: z
      .array(sentencePracticeWordUsageSchema)
      .length(SENTENCE_PRACTICE_WORD_COUNT)
      .refine(
        (usage) => new Set(usage.map((item) => item.entryId)).size === usage.length,
        'Duplicate word usage entries'
      )
      .refine(
        (usage) => usage.every((item) => item.used || !item.correct),
        'Unused words cannot be judged correct'
      ),
    fluency: z.strictObject({
      natural: z.boolean(),
      feedback: z.string().trim().min(1).max(SENTENCE_PRACTICE_FEEDBACK_MAX_LENGTH)
    }),
    grammar: z.strictObject({
      correct: z.boolean(),
      issues: z.array(sentencePracticeGrammarIssueSchema).max(SENTENCE_PRACTICE_ISSUES_MAX)
    }),
    summary: z.string().trim().min(1).max(SENTENCE_PRACTICE_SUMMARY_MAX_LENGTH),
    revisedAnswer: z
      .string()
      .trim()
      .min(1)
      .max(SENTENCE_PRACTICE_REVISED_ANSWER_MAX_LENGTH)
      .nullable()
  })
  .superRefine((review, context) => {
    // 语法正确时不得携带问题；报错时必须给出具体问题。
    if (review.grammar.correct && review.grammar.issues.length > 0) {
      context.addIssue({ code: 'custom', message: 'Grammar verdict contradicts issues' })
    }
    if (!review.grammar.correct && review.grammar.issues.length === 0) {
      context.addIssue({ code: 'custom', message: 'Grammar errors require issues' })
    }
  })
export type SentencePracticeReview = z.infer<typeof sentencePracticeReviewSchema>

export const sentencePracticeReviewResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), review: sentencePracticeReviewSchema }),
  z.strictObject({ status: z.literal('error'), error: sentencePracticeErrorSchema })
])
export type SentencePracticeReviewResult = z.infer<typeof sentencePracticeReviewResultSchema>

// 取消输入：按会话与在途请求 ID 中止调用；会话、单词、提示与答案保留。
export const sentencePracticeCancelInputSchema = z.strictObject({
  requestId: z.uuid(),
  sessionId: z.uuid()
})
export type SentencePracticeCancelInput = z.input<typeof sentencePracticeCancelInputSchema>

export const sentencePracticeCancelResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), cancelled: z.boolean() }),
  z.strictObject({ status: z.literal('error'), error: sentencePracticeErrorSchema })
])
export type SentencePracticeCancelResult = z.infer<typeof sentencePracticeCancelResultSchema>

// 关闭输入：中止在途调用并释放会话；重复关闭保持幂等。
export const sentencePracticeCloseInputSchema = z.strictObject({
  sessionId: z.uuid()
})
export type SentencePracticeCloseInput = z.input<typeof sentencePracticeCloseInputSchema>

export const sentencePracticeCloseResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), closed: z.boolean() }),
  z.strictObject({ status: z.literal('error'), error: sentencePracticeErrorSchema })
])
export type SentencePracticeCloseResult = z.infer<typeof sentencePracticeCloseResultSchema>

export interface SentencePracticeApi {
  start(input: SentencePracticeStartInput): Promise<SentencePracticeStartResult>
  hints(input: SentencePracticeHintsInput): Promise<SentencePracticeHintsResult>
  review(input: SentencePracticeReviewInput): Promise<SentencePracticeReviewResult>
  cancel(input: SentencePracticeCancelInput): Promise<SentencePracticeCancelResult>
  close(input: SentencePracticeCloseInput): Promise<SentencePracticeCloseResult>
}
