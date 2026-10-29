import { z } from 'zod'
import { targetLanguageSchema } from './preferences'

export const sentenceTextSchema = z
  .string()
  .max(4000)
  .refine((text) => text.length <= 4000)
  .transform((text) => text.trim())
  .pipe(z.string().min(1))
export const sentenceContentSchema = z.strictObject({
  sourceText: sentenceTextSchema,
  translation: z
    .string()
    .trim()
    .min(1)
    .max(32768)
    .refine((text) => text.length <= 32768),
  targetLanguage: targetLanguageSchema
})
export const sentenceEntrySchema = sentenceContentSchema.extend({
  id: z.uuid(),
  createdAt: z.iso.datetime()
})
export type SentenceEntry = z.infer<typeof sentenceEntrySchema>
export type SentenceContent = z.infer<typeof sentenceContentSchema>
export const sentenceReportSchema = z.strictObject({
  skillId: z.literal('sentence'),
  requestId: z.uuid(),
  explanationLanguage: z.enum(['zh-CN', 'en']),
  status: z.enum(['saved', 'existing']),
  entry: sentenceEntrySchema
})
export type SentenceReport = z.infer<typeof sentenceReportSchema>
export function isSentenceReport(value: unknown): value is SentenceReport {
  return sentenceReportSchema.safeParse(value).success
}
export const SENTENCE_CHANNELS = { list: 'sentence:list', delete: 'sentence:delete' } as const
export const sentenceManagementErrorSchema = z.strictObject({
  code: z.enum(['INVALID_INPUT', 'UNTRUSTED_SOURCE', 'STORAGE_FAILED', 'UNKNOWN_ERROR'])
})
export type SentenceManagementErrorCode = z.infer<typeof sentenceManagementErrorSchema>['code']
export const sentenceCursorSchema = z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() })
export type SentenceCursor = z.infer<typeof sentenceCursorSchema>
export const listSentenceInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: sentenceCursorSchema.optional()
})
export type ListSentenceInput = z.input<typeof listSentenceInputSchema>
export const sentencePageSchema = z.strictObject({
  entries: z.array(sentenceEntrySchema),
  nextCursor: sentenceCursorSchema.optional()
})
export type SentencePage = z.infer<typeof sentencePageSchema>
export const listSentenceResultSchema = z.discriminatedUnion('status', [
  sentencePageSchema.extend({ status: z.literal('ok') }),
  z.strictObject({ status: z.literal('error'), error: sentenceManagementErrorSchema })
])
export const deleteSentenceInputSchema = z.strictObject({ id: z.uuid() })
export const deleteSentenceResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), id: z.uuid(), deleted: z.boolean() }),
  z.strictObject({ status: z.literal('error'), error: sentenceManagementErrorSchema })
])
export interface SentenceApi {
  list(input: ListSentenceInput): Promise<z.infer<typeof listSentenceResultSchema>>
  delete(
    input: z.infer<typeof deleteSentenceInputSchema>
  ): Promise<z.infer<typeof deleteSentenceResultSchema>>
}
