import type { VocabularyTransferApi } from './vocabulary-transfer'
import { z } from 'zod'

const text = (max: number): z.ZodString => z.string().trim().min(1).max(max)

export const vocabularyErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'BUSY',
  'UNTRUSTED_SOURCE',
  'REQUEST_NOT_FOUND',
  'MODEL_NOT_CONFIGURED',
  'CREDENTIAL_DECRYPT_FAILED',
  'MODEL_ERROR',
  'INVALID_ANALYSIS',
  'TOOL_CALL_NOT_SUPPORTED',
  'UNRECOGNIZED',
  'TIMEOUT',
  'CANCELLED',
  'STORAGE_FAILED',
  'UNKNOWN_ERROR'
])
export type VocabularyErrorCode = z.infer<typeof vocabularyErrorCodeSchema>
export const vocabularyItemErrorCodeSchema = vocabularyErrorCodeSchema.exclude([
  'TOOL_CALL_NOT_SUPPORTED'
])
export type VocabularyItemErrorCode = z.infer<typeof vocabularyItemErrorCodeSchema>
export const addVocabularyBatchInputSchema = z.strictObject({
  requestId: z.uuid(),
  text: z.string().min(1).max(4000),
  wordLanguage: z.literal('en')
})
export const vocabularyCursorSchema = z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() })
export const listVocabularyInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: vocabularyCursorSchema.optional()
})
// 历史 v5 行允许四个内容字段为 NULL（迁移未回填旧分析），读取时不得因此失败。
export const vocabularyEntrySchema = z.strictObject({
  id: z.uuid(),
  term: text(4000),
  phonetic: z.string().min(1).max(200).nullable(),
  meaning: z.string().min(1).max(2000).nullable(),
  concept: z.string().min(1).max(2000).nullable(),
  exampleSentences: z.array(z.string().min(1).max(500)).min(1).max(3).nullable(),
  createdAt: z.iso.datetime()
})
const itemBase = z.strictObject({ inputIndex: z.number().int().min(0).max(19), term: text(4000) })
export const vocabularyItemResultSchema = z.discriminatedUnion('status', [
  itemBase.extend({ status: z.literal('saved'), entryId: z.uuid() }),
  itemBase.extend({ status: z.literal('existing'), entryId: z.uuid() }),
  itemBase.extend({
    status: z.literal('duplicate'),
    sourceInputIndex: z.number().int().min(0).max(19)
  }),
  itemBase.extend({ status: z.literal('failed'), code: vocabularyItemErrorCodeSchema })
])
export const vocabularyBatchSchema = z
  .strictObject({
    requestId: z.uuid(),
    outcome: z.enum(['completed', 'partial', 'failed', 'cancelled']),
    explanationLanguage: z.enum(['zh-CN', 'en']),
    items: z.array(vocabularyItemResultSchema).min(1).max(20),
    counts: z.strictObject({
      total: z.number().int().min(1).max(20),
      saved: z.number().int().nonnegative(),
      existing: z.number().int().nonnegative(),
      duplicate: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative()
    })
  })
  .superRefine((batch, context) => {
    const counts = { total: batch.items.length, saved: 0, existing: 0, duplicate: 0, failed: 0 }
    let resolved = 0
    let invalid = false
    for (const [index, item] of batch.items.entries()) {
      if (item.inputIndex !== index) invalid = true
      counts[item.status]++
      const source = item.status === 'duplicate' ? batch.items[item.sourceInputIndex] : item
      if (
        item.status === 'duplicate' &&
        (item.sourceInputIndex >= index || !source || source.status === 'duplicate')
      )
        invalid = true
      if (source?.status === 'saved' || source?.status === 'existing') resolved++
    }
    for (const key of ['total', 'saved', 'existing', 'duplicate', 'failed'] as const) {
      if (counts[key] !== batch.counts[key]) invalid = true
    }
    const expectedOutcome =
      resolved === counts.total ? 'completed' : resolved ? 'partial' : 'failed'
    if (batch.outcome === 'cancelled' ? counts.saved > 0 : batch.outcome !== expectedOutcome)
      invalid = true
    if (invalid) context.addIssue({ code: 'custom', message: 'Inconsistent batch result' })
  })

export type AddVocabularyBatchInput = z.infer<typeof addVocabularyBatchInputSchema>
export type VocabularyBatch = z.infer<typeof vocabularyBatchSchema>
export type VocabularyItemResult = z.infer<typeof vocabularyItemResultSchema>
export type VocabularyEntry = z.infer<typeof vocabularyEntrySchema>
export type VocabularyCursor = z.infer<typeof vocabularyCursorSchema>
export type ListVocabularyInput = z.input<typeof listVocabularyInputSchema>

// ── 已记录页词汇管理（列表与删除）IPC 协议 ──
// 与批量收藏分析共用本文件的内容 schema，但管理入口只允许预定义的
// 读取与删除 channel，不暴露任意 SQL；错误结果只携带安全错误码。
export const VOCABULARY_CHANNELS = {
  list: 'vocabulary:list',
  delete: 'vocabulary:delete'
} as const

export const VOCABULARY_MANAGEMENT_ERROR_CODES = [
  'UNTRUSTED_SOURCE',
  'INVALID_INPUT',
  'STORAGE_FAILED',
  'UNKNOWN_ERROR'
] as const
export type VocabularyManagementErrorCode = (typeof VOCABULARY_MANAGEMENT_ERROR_CODES)[number]
export const vocabularyManagementErrorSchema = z.strictObject({
  code: z.enum(VOCABULARY_MANAGEMENT_ERROR_CODES)
})
export type VocabularyManagementError = z.infer<typeof vocabularyManagementErrorSchema>

// 分页结果：entries 按创建时间倒序；nextCursor 缺省表示没有后续页。
export const vocabularyPageSchema = z.strictObject({
  entries: z.array(vocabularyEntrySchema),
  nextCursor: vocabularyCursorSchema.optional()
})
export type VocabularyPage = z.infer<typeof vocabularyPageSchema>

export const listVocabularyResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    entries: z.array(vocabularyEntrySchema),
    nextCursor: vocabularyCursorSchema.optional()
  }),
  z.strictObject({ status: z.literal('error'), error: vocabularyManagementErrorSchema })
])
export type ListVocabularyResult = z.infer<typeof listVocabularyResultSchema>

// 删除只接受记录 UUID：按 id 精确删除，不按 term 匹配，避免误删历史同名词。
export const deleteVocabularyInputSchema = z.strictObject({ id: z.uuid() })
export type DeleteVocabularyInput = z.input<typeof deleteVocabularyInputSchema>

// 目标 ID 不存在时返回成功且 deleted: false，保证重复请求幂等。
export const deleteVocabularyResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), id: z.uuid(), deleted: z.boolean() }),
  z.strictObject({ status: z.literal('error'), error: vocabularyManagementErrorSchema })
])
export type DeleteVocabularyResult = z.infer<typeof deleteVocabularyResultSchema>

export interface VocabularyApi extends VocabularyTransferApi {
  list(input: ListVocabularyInput): Promise<ListVocabularyResult>
  delete(input: DeleteVocabularyInput): Promise<DeleteVocabularyResult>
}

// 报告联合类型的判别守卫：vocabulary 与 phrase 报告结构互斥（term vs phrase 字段），
// 供会话层按 skillId 分派反馈时安全收窄，不做类型断言。
export function isVocabularyBatch(report: unknown): report is VocabularyBatch {
  return vocabularyBatchSchema.safeParse(report).success
}
