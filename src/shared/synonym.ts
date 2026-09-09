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
