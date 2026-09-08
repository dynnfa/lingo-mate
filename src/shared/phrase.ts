import { z } from 'zod'

// 短语收录协议：条目以规范化后的 phrase 文本为唯一标识（无独立 entryId），
// 字段名保留需求拼写 explantation；界面标签由翻译资源正常展示。

export const phraseErrorCodeSchema = z.enum([
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
export type PhraseErrorCode = z.infer<typeof phraseErrorCodeSchema>
export const phraseItemErrorCodeSchema = phraseErrorCodeSchema.exclude(['TOOL_CALL_NOT_SUPPORTED'])
export type PhraseItemErrorCode = z.infer<typeof phraseItemErrorCodeSchema>

// 多行批量输入：总长度上限与 IPC 文本一致，逐行解析由 Core 完成。
export const addPhraseBatchInputSchema = z.strictObject({
  requestId: z.uuid(),
  text: z.string().min(1).max(4000),
  wordLanguage: z.literal('en')
})

export const PHRASE_MAX_LENGTH = 200
export const PHRASE_EXPLANTATION_MAX_LENGTH = 2000
export const PHRASE_EXAMPLE_MAX_LENGTH = 1000

export const phraseEntrySchema = z.strictObject({
  phrase: z.string().trim().min(1).max(PHRASE_MAX_LENGTH),
  explantation: z.string().trim().min(1).max(PHRASE_EXPLANTATION_MAX_LENGTH),
  example: z.string().trim().min(1).max(PHRASE_EXAMPLE_MAX_LENGTH)
})
export type PhraseEntry = z.infer<typeof phraseEntrySchema>

// input 是用户原始输入行（去掉行结束符）；phrase 是本地规范化文本，也是条目标识。
const itemBase = z.strictObject({
  inputIndex: z.number().int().min(0).max(19),
  input: z.string().min(1).max(4000),
  phrase: z.string().trim().min(1).max(PHRASE_MAX_LENGTH)
})
export const phraseItemResultSchema = z.discriminatedUnion('status', [
  itemBase.extend({ status: z.literal('saved') }),
  itemBase.extend({ status: z.literal('existing') }),
  itemBase.extend({
    status: z.literal('duplicate'),
    sourceInputIndex: z.number().int().min(0).max(19)
  }),
  itemBase.extend({ status: z.literal('failed'), code: phraseItemErrorCodeSchema })
])
export const phraseBatchSchema = z
  .strictObject({
    requestId: z.uuid(),
    outcome: z.enum(['completed', 'partial', 'failed', 'cancelled']),
    explanationLanguage: z.enum(['zh-CN', 'en']),
    items: z.array(phraseItemResultSchema).min(1).max(20),
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
    if (invalid) context.addIssue({ code: 'custom', message: 'Inconsistent phrase batch result' })
  })

export type AddPhraseBatchInput = z.infer<typeof addPhraseBatchInputSchema>
export type PhraseBatch = z.infer<typeof phraseBatchSchema>
export type PhraseItemResult = z.infer<typeof phraseItemResultSchema>

// 报告联合类型的判别守卫：见 shared/vocabulary.ts 的同名说明。
export function isPhraseBatch(report: unknown): report is PhraseBatch {
  return phraseBatchSchema.safeParse(report).success
}
