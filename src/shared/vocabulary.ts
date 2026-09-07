import { z } from 'zod'

const text = (max: number): z.ZodString => z.string().trim().min(1).max(max)
export const vocabularyAnalysisSchema = z
  .strictObject({
    senses: z
      .array(
        z.strictObject({
          id: z.string().regex(/^s[1-5]$/),
          partOfSpeech: z.enum([
            'noun',
            'verb',
            'adjective',
            'adverb',
            'pronoun',
            'preposition',
            'conjunction',
            'interjection',
            'determiner',
            'phrase',
            'other'
          ]),
          definition: text(500)
        })
      )
      .min(1)
      .max(5),
    pronunciations: z
      .array(
        z.strictObject({
          accent: z.enum(['en-US', 'en-GB', 'unspecified']),
          ipa: text(200).regex(/^(\/[^/]+\/|\[[^[\]]+\])$/),
          guidance: text(500),
          senseIds: z
            .array(z.string().regex(/^s[1-5]$/))
            .min(1)
            .max(5)
        })
      )
      .min(1)
      .max(6)
  })
  .superRefine((analysis, context) => {
    const ids = new Set(analysis.senses.map((sense) => sense.id))
    const linked = new Set<string>()
    let invalid = ids.size !== analysis.senses.length
    for (const pronunciation of analysis.pronunciations) {
      if (new Set(pronunciation.senseIds).size !== pronunciation.senseIds.length) invalid = true
      for (const id of pronunciation.senseIds) {
        if (!ids.has(id)) invalid = true
        linked.add(id)
      }
      const phonemes = pronunciation.ipa.slice(1, -1).trim()
      if (!/\p{Letter}/u.test(phonemes) || /[?\d]|unknown|unavailable|n\/a/i.test(phonemes))
        invalid = true
    }
    if ([...ids].some((id) => !linked.has(id))) invalid = true
    if (invalid)
      context.addIssue({ code: 'custom', message: 'Invalid pronunciation or sense references' })
  })
export type VocabularyAnalysis = z.infer<typeof vocabularyAnalysisSchema>

export const vocabularyErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'BUSY',
  'UNTRUSTED_SOURCE',
  'REQUEST_NOT_FOUND',
  'MODEL_NOT_CONFIGURED',
  'CREDENTIAL_DECRYPT_FAILED',
  'MODEL_ERROR',
  'INVALID_ANALYSIS',
  'UNRECOGNIZED',
  'TIMEOUT',
  'CANCELLED',
  'STORAGE_FAILED',
  'UNKNOWN_ERROR'
])
export type VocabularyErrorCode = z.infer<typeof vocabularyErrorCodeSchema>
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
export const vocabularyEntrySchema = z.strictObject({
  id: z.uuid(),
  term: text(4000),
  wordLanguage: z.literal('en'),
  explanationLanguage: z.enum(['zh-CN', 'en']),
  analysis: vocabularyAnalysisSchema,
  analysisSource: z.literal('llm'),
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
  itemBase.extend({ status: z.literal('failed'), code: vocabularyErrorCodeSchema })
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
