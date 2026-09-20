import { z } from 'zod'
import type {
  ListVocabularyMistakeHistoryQuery,
  ListVocabularyMistakesQuery,
  VocabularyMistakeHistoryCursor,
  VocabularyMistakeHistoryItem,
  VocabularyMistakeListItem,
  VocabularyMistakesListCursor
} from '../../../shared/vocabulary-mistakes'
import {
  VOCABULARY_MISTAKES_MEANING_MAX_LENGTH,
  VOCABULARY_MISTAKES_TERM_MAX_LENGTH
} from '../../../shared/vocabulary-mistakes'

// 一次审查中产生的单条错题：term 与 submittedMeaning 是练习开始时快照
// 与本次提交释义的原文，独立于词库保存。
export interface VocabularyMistakeRecord {
  id: string
  reviewId: string
  entryId: string
  term: string
  submittedMeaning: string
  createdAt: string
}

export interface VocabularyMistakesPage {
  entries: VocabularyMistakeListItem[]
  nextCursor?: VocabularyMistakesListCursor
}

export interface VocabularyMistakeHistoryPage {
  items: VocabularyMistakeHistoryItem[]
  nextCursor?: VocabularyMistakeHistoryCursor
}

// 仓储写入前的防御性校验：Core 构造的记录必须完整可入库。
export const vocabularyMistakeRecordSchema = z
  .object({
    id: z.uuid(),
    reviewId: z.uuid(),
    entryId: z.uuid(),
    term: z
      .string()
      .refine((value) => value.trim().length >= 1)
      .max(VOCABULARY_MISTAKES_TERM_MAX_LENGTH),
    submittedMeaning: z
      .string()
      .refine((value) => value.trim().length >= 1)
      .max(VOCABULARY_MISTAKES_MEANING_MAX_LENGTH),
    createdAt: z.iso.datetime()
  })
  .strict()

export interface VocabularyMistakeRepository {
  // 同一次审查的全部错题在一个事务内写入；(review_id, entry_id) 冲突时
  // 幂等跳过，保存重试不重复计数。空批次为无操作。
  saveBatch(records: VocabularyMistakeRecord[]): void
  // 查询入参为 IPC 边界校验后的结果（limit 已含默认值），本层不再重复校验。
  // 按词条聚合的错题列表：最近错误时间倒序，entryId 作稳定排序条件。
  list(query: ListVocabularyMistakesQuery): VocabularyMistakesPage
  // 单词条的错误释义历史：发生时间倒序，记录 id 作稳定排序条件。
  listHistory(query: ListVocabularyMistakeHistoryQuery): VocabularyMistakeHistoryPage
}
