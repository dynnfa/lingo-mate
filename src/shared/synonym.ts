import { z } from 'zod'

export const SYNONYM_MAX_LENGTH = 100
export const synonymErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'MODEL_NOT_CONFIGURED',
  'CREDENTIAL_DECRYPT_FAILED',
  'MODEL_ERROR',
  'INVALID_ANALYSIS',
  'TOOL_CALL_NOT_SUPPORTED',
  'TIMEOUT',
  'CANCELLED',
  'STORAGE_FAILED',
  'SCAN_LIMIT',
  'ROUND_LIMIT'
])
export type SynonymErrorCode = z.infer<typeof synonymErrorCodeSchema>
export const synonymTextSchema = z.string().trim().min(1).max(2000)
export const synonymWordSchema = z
  .string()
  .min(1)
  .max(SYNONYM_MAX_LENGTH)
  .refine((word) => word === word.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase())
export const synonymEntrySchema = z.strictObject({
  id: z.uuid(),
  word: synonymWordSchema,
  meaning: synonymTextSchema,
  groupid: z.uuid(),
  distinction: synonymTextSchema
})
export type SynonymEntry = z.infer<typeof synonymEntrySchema>
const itemBase = z.strictObject({
  inputIndex: z.number().int().min(0).max(19),
  input: z.string().min(1).max(4000),
  word: synonymWordSchema
})
export const synonymItemResultSchema = z.discriminatedUnion('status', [
  itemBase.extend({ status: z.literal('saved'), entry: synonymEntrySchema }),
  itemBase.extend({ status: z.literal('existing'), entry: synonymEntrySchema }),
  itemBase.extend({
    status: z.literal('duplicate'),
    sourceInputIndex: z.number().int().min(0).max(19)
  }),
  itemBase.extend({ status: z.literal('unrecognized') }),
  itemBase.extend({ status: z.literal('cancelled') }),
  itemBase.extend({ status: z.literal('failed'), code: synonymErrorCodeSchema })
])
export type SynonymItemResult = z.infer<typeof synonymItemResultSchema>
export const synonymBatchSchema = z
  .strictObject({
    requestId: z.uuid(),
    // Missing on older reports; only true authorizes reply-only recovery.
    finalized: z.boolean().optional(),
    explanationLanguage: z.enum(['zh-CN', 'en']),
    outcome: z.enum(['completed', 'partial', 'failed', 'cancelled']),
    items: z.array(synonymItemResultSchema).min(1).max(20)
  })
  .superRefine((batch, ctx) => {
    let invalid = false
    for (const [index, item] of batch.items.entries()) {
      if (item.inputIndex !== index) invalid = true
      if ((item.status === 'saved' || item.status === 'existing') && item.entry.word !== item.word)
        invalid = true
      if (item.status === 'duplicate') {
        const source = batch.items[item.sourceInputIndex]
        if (
          item.sourceInputIndex >= index ||
          !source ||
          source.status === 'duplicate' ||
          source.word !== item.word
        )
          invalid = true
      }
    }
    if (batch.outcome !== synonymOutcome(batch.items)) invalid = true
    if (invalid) ctx.addIssue({ code: 'custom', message: 'Inconsistent synonym report' })
  })
export type SynonymBatch = z.infer<typeof synonymBatchSchema>
export function synonymOutcome(items: SynonymItemResult[]): SynonymBatch['outcome'] {
  if (items.some((item) => item.status === 'cancelled')) return 'cancelled'
  const resolved = items.filter((item) => {
    const source = item.status === 'duplicate' ? items[item.sourceInputIndex] : item
    return source?.status === 'saved' || source?.status === 'existing'
  }).length
  return resolved === items.length ? 'completed' : resolved ? 'partial' : 'failed'
}

// ── 已记录页近义词管理（分组列表）IPC 协议 ──
// 与收藏分析共用本文件的词条 schema，但管理入口只允许预定义的读取
// channel，不暴露任意 SQL；错误结果只携带安全错误码。
export const SYNONYM_CHANNELS = {
  list: 'synonym:list'
} as const

export const SYNONYM_MANAGEMENT_ERROR_CODES = [
  'UNTRUSTED_SOURCE',
  'INVALID_INPUT',
  'STORAGE_FAILED',
  'UNKNOWN_ERROR'
] as const
export type SynonymManagementErrorCode = (typeof SYNONYM_MANAGEMENT_ERROR_CODES)[number]
export const synonymManagementErrorSchema = z.strictObject({
  code: z.enum(SYNONYM_MANAGEMENT_ERROR_CODES)
})
export type SynonymManagementError = z.infer<typeof synonymManagementErrorSchema>

// 列表输入：游标为上一页最后一组的 UUID，分页以完整 group 为单位。
export const synonymListInputSchema = z.strictObject({ cursor: z.uuid().optional() })
export type SynonymListInput = z.input<typeof synonymListInputSchema>

// 分组必须携带至少一条词条，且每条词条的 groupid 与所属组一致；
// 释义相同但 ID 不同的组是两个组，由 id 而非 meaning 区分。
export const synonymGroupSchema = z
  .strictObject({
    id: z.uuid(),
    meaning: synonymTextSchema,
    words: z.array(synonymEntrySchema).min(1)
  })
  .superRefine((group, ctx) => {
    if (group.words.some((entry) => entry.groupid !== group.id))
      ctx.addIssue({ code: 'custom', message: 'Synonym entry belongs to another group' })
  })
export type SynonymGroup = z.infer<typeof synonymGroupSchema>

// 分页结果：groups 按组 ID 升序返回完整组；nextCursor 为 null 表示没有后续页。
export const synonymGroupPageSchema = z.strictObject({
  groups: z.array(synonymGroupSchema),
  nextCursor: z.uuid().nullable()
})
export type SynonymGroupPage = z.infer<typeof synonymGroupPageSchema>

export const synonymListResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    groups: z.array(synonymGroupSchema),
    nextCursor: z.uuid().nullable()
  }),
  z.strictObject({ status: z.literal('error'), error: synonymManagementErrorSchema })
])
export type SynonymListResult = z.infer<typeof synonymListResultSchema>

export interface SynonymApi {
  list(input: SynonymListInput): Promise<SynonymListResult>
}
