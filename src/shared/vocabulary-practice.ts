import { z } from 'zod'

// ── 词汇练习 IPC 协议 ──
// 首版只有“看单词写释义”一种模式：开始时从词库随机抽取词条快照，
// 提交后由模型逐项审查并通过 mark_text_red 工具标红错误释义。
// 练习与审查状态保存在内存会话中，不新增持久化数据。

export const VOCABULARY_PRACTICE_COUNT_MIN = 1
export const VOCABULARY_PRACTICE_COUNT_MAX = 50
export const VOCABULARY_PRACTICE_DEFAULT_COUNT = 10
export const VOCABULARY_PRACTICE_MEANING_MAX_LENGTH = 2000
export const VOCABULARY_PRACTICE_MARK_REASON_MAX_LENGTH = 500
export const VOCABULARY_PRACTICE_SUMMARY_MAX_LENGTH = 2000

export const VOCABULARY_PRACTICE_CHANNELS = {
  start: 'vocabulary-practice:start',
  review: 'vocabulary-practice:review',
  cancel: 'vocabulary-practice:cancel'
} as const

export const vocabularyPracticeErrorCodeSchema = z.enum([
  'UNTRUSTED_SOURCE',
  'INVALID_INPUT',
  'SESSION_NOT_FOUND',
  'BUSY',
  'MODEL_NOT_CONFIGURED',
  'CREDENTIAL_DECRYPT_FAILED',
  'MODEL_ERROR',
  'INVALID_ANALYSIS',
  'TOOL_CALL_NOT_SUPPORTED',
  'TIMEOUT',
  'CANCELLED',
  'ROUND_LIMIT',
  'STORAGE_FAILED',
  'UNKNOWN_ERROR'
])
export type VocabularyPracticeErrorCode = z.infer<typeof vocabularyPracticeErrorCodeSchema>
export const vocabularyPracticeErrorSchema = z.strictObject({
  code: vocabularyPracticeErrorCodeSchema
})
export type VocabularyPracticeError = z.infer<typeof vocabularyPracticeErrorSchema>

// 开始输入：requestId 便于关联调用方日志；count 是期望抽取的词条数。
export const vocabularyPracticeStartInputSchema = z.strictObject({
  requestId: z.uuid(),
  count: z.number().int().min(VOCABULARY_PRACTICE_COUNT_MIN).max(VOCABULARY_PRACTICE_COUNT_MAX)
})
export type VocabularyPracticeStartInput = z.input<typeof vocabularyPracticeStartInputSchema>

// 词条只暴露练习需要的身份与单词：参考释义留在 Main 内部，不预填答案。
export const vocabularyPracticeEntrySchema = z.strictObject({
  entryId: z.uuid(),
  term: z.string().min(1).max(4000)
})
export type VocabularyPracticeEntry = z.infer<typeof vocabularyPracticeEntrySchema>

export const vocabularyPracticeStartResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('ok'),
      sessionId: z.uuid(),
      requestedCount: z
        .number()
        .int()
        .min(VOCABULARY_PRACTICE_COUNT_MIN)
        .max(VOCABULARY_PRACTICE_COUNT_MAX),
      // 词库不足时返回全部可用词条，actualCount 为实际抽取数量（空词库为 0）。
      actualCount: z.number().int().min(0),
      entries: z.array(vocabularyPracticeEntrySchema)
    }),
    z.strictObject({ status: z.literal('error'), error: vocabularyPracticeErrorSchema })
  ])
  .superRefine((result, context) => {
    if (result.status === 'error') return
    if (result.actualCount !== result.entries.length || result.actualCount > result.requestedCount)
      context.addIssue({ code: 'custom', message: 'Inconsistent practice start result' })
  })
export type VocabularyPracticeStartResult = z.infer<typeof vocabularyPracticeStartResultSchema>

// 审查输入：Renderer 只提交答案；Core 按 sessionId 找回快照并组装可信单词。
export const vocabularyPracticeAnswerSchema = z.strictObject({
  entryId: z.uuid(),
  meaning: z.string().trim().min(1).max(VOCABULARY_PRACTICE_MEANING_MAX_LENGTH)
})
export const vocabularyPracticeReviewInputSchema = z.strictObject({
  requestId: z.uuid(),
  sessionId: z.uuid(),
  answers: z
    .array(vocabularyPracticeAnswerSchema)
    .min(VOCABULARY_PRACTICE_COUNT_MIN)
    .max(VOCABULARY_PRACTICE_COUNT_MAX)
})
export type VocabularyPracticeReviewInput = z.input<typeof vocabularyPracticeReviewInputSchema>

// 标红结果来自校验后的模型工具参数：只允许 meaning 字段，reason 是模型给出的错误原因。
export const vocabularyPracticeMarkSchema = z.strictObject({
  entryId: z.uuid(),
  field: z.literal('meaning'),
  reason: z.string().trim().min(1).max(VOCABULARY_PRACTICE_MARK_REASON_MAX_LENGTH)
})
export type VocabularyPracticeMark = z.infer<typeof vocabularyPracticeMarkSchema>

export const vocabularyPracticeReviewResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('ok'),
      verdict: z.enum(['all_correct', 'has_errors']),
      summary: z.string().trim().min(1).max(VOCABULARY_PRACTICE_SUMMARY_MAX_LENGTH),
      marks: z.array(vocabularyPracticeMarkSchema)
    }),
    z.strictObject({ status: z.literal('error'), error: vocabularyPracticeErrorSchema })
  ])
  .superRefine((result, context) => {
    if (result.status === 'error') return
    // 判为全部正确时不得携带错误标记；标记与反馈矛盾属于无效审查。
    if (result.verdict === 'all_correct' && result.marks.length > 0)
      context.addIssue({ code: 'custom', message: 'Verdict contradicts error marks' })
  })
export type VocabularyPracticeReviewResult = z.infer<typeof vocabularyPracticeReviewResultSchema>

// 取消输入：中止当前审查请求并清除未完成标记；会话与已填答案保留。
export const vocabularyPracticeCancelInputSchema = z.strictObject({ sessionId: z.uuid() })
export type VocabularyPracticeCancelInput = z.input<typeof vocabularyPracticeCancelInputSchema>

export const vocabularyPracticeCancelResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), cancelled: z.boolean() }),
  z.strictObject({ status: z.literal('error'), error: vocabularyPracticeErrorSchema })
])
export type VocabularyPracticeCancelResult = z.infer<typeof vocabularyPracticeCancelResultSchema>

export interface VocabularyPracticeApi {
  start(input: VocabularyPracticeStartInput): Promise<VocabularyPracticeStartResult>
  review(input: VocabularyPracticeReviewInput): Promise<VocabularyPracticeReviewResult>
  cancel(input: VocabularyPracticeCancelInput): Promise<VocabularyPracticeCancelResult>
}
