import { z } from 'zod'

// /explore-vocabulary 探索协议：批次结构同时充当 JSON 历史文件条目与会话
// 技能报告。历史文件是该技能生成结果与去重数据的唯一业务存储；报告仅额外
// 携带 skillId 判别字段，不写入 conversation_skill_executions.batch_json。
// 字段使用 term/normalizedTerm，与 vocabulary 领域术语一致。

export const EXPLORE_VOCABULARY_SKILL_ID = 'explore-vocabulary' as const

// 每批固定 10 个单词；历史保留最近 7 批（最多 70 个单词）用于去重。
export const EXPLORE_VOCABULARY_ITEM_COUNT = 10
export const EXPLORE_VOCABULARY_HISTORY_BATCH_LIMIT = 7

export const EXPLORE_VOCABULARY_TERM_MAX_LENGTH = 200
export const EXPLORE_VOCABULARY_EXPLANATION_MAX_LENGTH = 1000
export const EXPLORE_VOCABULARY_EXAMPLE_MAX_LENGTH = 1000

// 三个模型字段都是单行文本：含换行的条目视为不合格，不得通过换行破坏表格。
const singleLineText = (maxLength: number): z.ZodType<string> =>
  z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine((value) => !/[\r\n]/u.test(value), { message: 'Must be a single line' })

// 历史条目：normalizedTerm 由应用按统一规范化规则计算并保存，读取时
// 重新计算核对；跨层一致性校验由 Core 完成（shared 不承载规范化实现）。
export const exploreVocabularyHistoryItemSchema = z.strictObject({
  term: singleLineText(EXPLORE_VOCABULARY_TERM_MAX_LENGTH),
  normalizedTerm: z.string().min(1).max(EXPLORE_VOCABULARY_TERM_MAX_LENGTH),
  explanation: singleLineText(EXPLORE_VOCABULARY_EXPLANATION_MAX_LENGTH),
  example: singleLineText(EXPLORE_VOCABULARY_EXAMPLE_MAX_LENGTH)
})
export type ExploreVocabularyHistoryItem = z.infer<typeof exploreVocabularyHistoryItemSchema>

export const exploreVocabularyHistoryBatchSchema = z
  .strictObject({
    executionId: z.uuid(),
    sessionId: z.uuid(),
    userMessageId: z.uuid(),
    committedAt: z.iso.datetime(),
    wordLanguage: z.literal('en'),
    explanationLanguage: z.enum(['zh-CN', 'en']),
    items: z.array(exploreVocabularyHistoryItemSchema).length(EXPLORE_VOCABULARY_ITEM_COUNT)
  })
  .superRefine((batch, context) => {
    // 批内单词按规范化键不得重复：释义或例句不同不使重复单词有效。
    const seen = new Set<string>()
    for (const item of batch.items) {
      if (seen.has(item.normalizedTerm)) {
        context.addIssue({ code: 'custom', message: 'Duplicate term inside batch' })
        return
      }
      seen.add(item.normalizedTerm)
    }
  })
export type ExploreVocabularyBatch = z.infer<typeof exploreVocabularyHistoryBatchSchema>

// 历史文档：批次按提交顺序排列，最新批次位于数组末尾。
export const exploreVocabularyHistoryDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  batches: z.array(exploreVocabularyHistoryBatchSchema).max(EXPLORE_VOCABULARY_HISTORY_BATCH_LIMIT)
})
export type ExploreVocabularyHistoryDocument = z.infer<
  typeof exploreVocabularyHistoryDocumentSchema
>

// 会话技能报告：批次 + 稳定技能判别字段。用于反馈分派的类型判别。
export const exploreVocabularyReportSchema = exploreVocabularyHistoryBatchSchema.extend({
  skillId: z.literal(EXPLORE_VOCABULARY_SKILL_ID)
})
export type ExploreVocabularyReport = z.infer<typeof exploreVocabularyReportSchema>

export function isExploreVocabularyReport(report: unknown): report is ExploreVocabularyReport {
  return exploreVocabularyReportSchema.safeParse(report).success
}
