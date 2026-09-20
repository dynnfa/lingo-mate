import { z } from 'zod'

// ── 词汇练习错题集 IPC 协议 ──
// 错题由 Main 在审查成功后从可信审查结果中收集入库；本协议只面向
// 错题集页面提供只读分页查询（按词条聚合的列表与单词条历史），
// 不提供写入、删除或读取任意用户数据的入口。

export const VOCABULARY_MISTAKES_LIMIT_MIN = 1
export const VOCABULARY_MISTAKES_LIMIT_MAX = 100
export const VOCABULARY_MISTAKES_LIMIT_DEFAULT = 50
export const VOCABULARY_MISTAKES_TERM_MAX_LENGTH = 4000
export const VOCABULARY_MISTAKES_MEANING_MAX_LENGTH = 2000

export const VOCABULARY_MISTAKES_CHANNELS = {
  list: 'vocabulary-mistakes:list',
  listHistory: 'vocabulary-mistakes:listHistory'
} as const

export const vocabularyMistakesErrorCodeSchema = z.enum([
  'UNTRUSTED_SOURCE',
  'INVALID_INPUT',
  'STORAGE_FAILED',
  'UNKNOWN_ERROR'
])
export type VocabularyMistakesErrorCode = z.infer<typeof vocabularyMistakesErrorCodeSchema>
export const vocabularyMistakesErrorSchema = z.strictObject({
  code: vocabularyMistakesErrorCodeSchema
})
export type VocabularyMistakesError = z.infer<typeof vocabularyMistakesErrorSchema>

// 聚合列表游标：按最近错误时间倒序翻页，entryId 作同时间稳定排序条件。
export const vocabularyMistakesListCursorSchema = z.strictObject({
  lastErrorAt: z.iso.datetime(),
  entryId: z.uuid()
})
export type VocabularyMistakesListCursor = z.infer<typeof vocabularyMistakesListCursorSchema>

export const listVocabularyMistakesInputSchema = z.strictObject({
  limit: z
    .number()
    .int()
    .min(VOCABULARY_MISTAKES_LIMIT_MIN)
    .max(VOCABULARY_MISTAKES_LIMIT_MAX)
    .default(VOCABULARY_MISTAKES_LIMIT_DEFAULT),
  cursor: vocabularyMistakesListCursorSchema.optional()
})
export type ListVocabularyMistakesInput = z.input<typeof listVocabularyMistakesInputSchema>

// 聚合行：一个词条一行；释义与单词是错题落库时的快照，不回读词库。
export const vocabularyMistakeListItemSchema = z.strictObject({
  entryId: z.uuid(),
  term: z.string().trim().min(1).max(VOCABULARY_MISTAKES_TERM_MAX_LENGTH),
  lastSubmittedMeaning: z.string().trim().min(1).max(VOCABULARY_MISTAKES_MEANING_MAX_LENGTH),
  totalMistakes: z.number().int().min(1),
  lastErrorAt: z.iso.datetime()
})
export type VocabularyMistakeListItem = z.infer<typeof vocabularyMistakeListItemSchema>

export const listVocabularyMistakesResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    entries: z.array(vocabularyMistakeListItemSchema),
    nextCursor: vocabularyMistakesListCursorSchema.optional()
  }),
  z.strictObject({ status: z.literal('error'), error: vocabularyMistakesErrorSchema })
])
export type ListVocabularyMistakesResult = z.infer<typeof listVocabularyMistakesResultSchema>

// 历史查询：单词条的错误释义历史，按发生时间倒序分页。
export const vocabularyMistakeHistoryCursorSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid()
})
export type VocabularyMistakeHistoryCursor = z.infer<typeof vocabularyMistakeHistoryCursorSchema>

export const listVocabularyMistakeHistoryInputSchema = z.strictObject({
  entryId: z.uuid(),
  limit: z
    .number()
    .int()
    .min(VOCABULARY_MISTAKES_LIMIT_MIN)
    .max(VOCABULARY_MISTAKES_LIMIT_MAX)
    .default(VOCABULARY_MISTAKES_LIMIT_DEFAULT),
  cursor: vocabularyMistakeHistoryCursorSchema.optional()
})
export type ListVocabularyMistakeHistoryInput = z.input<
  typeof listVocabularyMistakeHistoryInputSchema
>

export const vocabularyMistakeHistoryItemSchema = z.strictObject({
  id: z.uuid(),
  submittedMeaning: z.string().trim().min(1).max(VOCABULARY_MISTAKES_MEANING_MAX_LENGTH),
  createdAt: z.iso.datetime()
})
export type VocabularyMistakeHistoryItem = z.infer<typeof vocabularyMistakeHistoryItemSchema>

export const listVocabularyMistakeHistoryResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    items: z.array(vocabularyMistakeHistoryItemSchema),
    nextCursor: vocabularyMistakeHistoryCursorSchema.optional()
  }),
  z.strictObject({ status: z.literal('error'), error: vocabularyMistakesErrorSchema })
])
export type ListVocabularyMistakeHistoryResult = z.infer<
  typeof listVocabularyMistakeHistoryResultSchema
>

export interface VocabularyMistakesApi {
  list(input: ListVocabularyMistakesInput): Promise<ListVocabularyMistakesResult>
  listHistory(input: ListVocabularyMistakeHistoryInput): Promise<ListVocabularyMistakeHistoryResult>
}
