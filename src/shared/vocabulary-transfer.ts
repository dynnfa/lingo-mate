import { z } from 'zod'
import { vocabularyErrorCodeSchema } from './vocabulary'

export const VOCABULARY_COLUMNS = [
  'term',
  'phonetic',
  'meaning',
  'concept',
  'example_sentence_1',
  'example_sentence_2',
  'example_sentence_3'
] as const
export const VOCABULARY_TRANSFER_LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  expandedBytes: 24 * 1024 * 1024,
  cells: 20000,
  columns: 64,
  archiveEntries: 100,
  xmlElements: 200000,
  excelRows: 1000,
  aiRows: 100,
  textLength: 10000,
  previewMs: 15 * 60 * 1000
} as const
export const VOCABULARY_TRANSFER_CHANNELS = {
  template: 'vocabulary:template',
  preview: 'vocabulary:preview-excel',
  confirm: 'vocabulary:confirm-excel',
  start: 'vocabulary:start-import',
  task: 'vocabulary:import-task',
  cancel: 'vocabulary:cancel-import',
  export: 'vocabulary:export-excel',
  event: 'vocabulary:import-progress'
} as const
export const transferErrorCodeSchema = z.enum([
  ...vocabularyErrorCodeSchema.options,
  'INVALID_FILE',
  'LIMIT_EXCEEDED',
  'PREVIEW_EXPIRED',
  'FILE_ERROR'
])
export type TransferErrorCode = z.infer<typeof transferErrorCodeSchema>
export const transferErrorSchema = z.strictObject({ code: transferErrorCodeSchema })
const error = z.strictObject({ status: z.literal('error'), error: transferErrorSchema })
export const fileResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok') }),
  z.strictObject({ status: z.literal('cancelled') }),
  error
])
export const importIssueSchema = z.strictObject({
  row: z.number().int().positive(),
  field: z.enum([...VOCABULARY_COLUMNS, 'header']),
  code: z.enum(['REQUIRED', 'INVALID_VALUE', 'INVALID_CELL', 'INVALID_HEADER'])
})
export type ImportIssue = z.infer<typeof importIssueSchema>
export const importRowSchema = z.strictObject({
  row: z.number().int().positive(),
  term: z.string().max(4000),
  status: z.enum(['pending', 'analyzed', 'saved', 'existing', 'duplicate', 'failed']),
  code: transferErrorCodeSchema.optional(),
  sourceRow: z.number().int().positive().optional()
})
export type ImportRow = z.infer<typeof importRowSchema>
export const importTaskSchema = z.strictObject({
  kind: z.enum(['excel', 'ai']),
  requestId: z.uuid(),
  revision: z.number().int().nonnegative(),
  phase: z.enum(['analyzing', 'committing', 'completed', 'partial', 'failed', 'cancelled']),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  rows: z.array(importRowSchema).max(VOCABULARY_TRANSFER_LIMITS.excelRows),
  counts: z.strictObject({
    saved: z.number().int().nonnegative(),
    existing: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative()
  })
})
export type ImportTask = z.infer<typeof importTaskSchema>
export const taskResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), task: importTaskSchema.nullable() }),
  error
])
export const previewSchema = z.strictObject({
  importId: z.uuid(),
  total: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
  existing: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  issues: z.array(importIssueSchema)
})
export type ImportPreview = z.infer<typeof previewSchema>
export const previewResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), preview: previewSchema }),
  z.strictObject({ status: z.literal('cancelled') }),
  error
])
export const confirmImportSchema = z.strictObject({ importId: z.uuid() })
export const startImportSchema = z.strictObject({
  requestId: z.uuid(),
  text: z.string().min(1).max(VOCABULARY_TRANSFER_LIMITS.textLength),
  retryRequestId: z.uuid().optional()
})
export const taskInputSchema = z.strictObject({ requestId: z.uuid().optional() })
export const cancelImportSchema = z.strictObject({ requestId: z.uuid() })
export interface VocabularyTransferApi {
  downloadTemplate(): Promise<z.infer<typeof fileResultSchema>>
  previewExcel(): Promise<z.infer<typeof previewResultSchema>>
  confirmExcel(
    input: z.infer<typeof confirmImportSchema>
  ): Promise<z.infer<typeof taskResultSchema>>
  startImport(input: z.infer<typeof startImportSchema>): Promise<z.infer<typeof taskResultSchema>>
  getImportTask(input: z.infer<typeof taskInputSchema>): Promise<z.infer<typeof taskResultSchema>>
  cancelImport(input: z.infer<typeof cancelImportSchema>): Promise<z.infer<typeof taskResultSchema>>
  exportExcel(): Promise<z.infer<typeof fileResultSchema>>
  onImportProgress(listener: (task: ImportTask) => void): () => void
}
