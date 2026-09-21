import { z } from 'zod'

// /explore-phrase 探索协议：批次结构同时充当 JSON 历史文件条目与会话技能
// 报告。历史文件是该技能生成结果与去重数据的唯一业务存储；报告仅额外携带
// skillId 判别字段，不写入 conversation_skill_executions.batch_json。

export const EXPLORE_PHRASE_SKILL_ID = 'explore-phrase' as const

// 每批固定 10 个短语；历史保留最近 7 批（最多 70 个短语）用于去重。
export const EXPLORE_PHRASE_ITEM_COUNT = 10
export const EXPLORE_PHRASE_HISTORY_BATCH_LIMIT = 7

export const EXPLORE_PHRASE_MAX_LENGTH = 200
export const EXPLORE_PHRASE_EXPLANATION_MAX_LENGTH = 1000
export const EXPLORE_PHRASE_EXAMPLE_MAX_LENGTH = 1000

// 三个模型字段都是单行文本：含换行的条目视为不合格，不得通过换行破坏表格。
const singleLineText = (maxLength: number): z.ZodType<string> =>
  z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine((value) => !/[\r\n]/u.test(value), { message: 'Must be a single line' })

// 历史条目：normalizedPhrase 由应用按统一规范化规则计算并保存，读取时
// 重新计算核对；跨层一致性校验由 Core 完成（shared 不承载规范化实现）。
export const explorePhraseHistoryItemSchema = z.strictObject({
  phrase: singleLineText(EXPLORE_PHRASE_MAX_LENGTH),
  normalizedPhrase: z.string().min(1).max(EXPLORE_PHRASE_MAX_LENGTH),
  explanation: singleLineText(EXPLORE_PHRASE_EXPLANATION_MAX_LENGTH),
  example: singleLineText(EXPLORE_PHRASE_EXAMPLE_MAX_LENGTH)
})
export type ExplorePhraseHistoryItem = z.infer<typeof explorePhraseHistoryItemSchema>

export const explorePhraseHistoryBatchSchema = z
  .strictObject({
    executionId: z.uuid(),
    sessionId: z.uuid(),
    userMessageId: z.uuid(),
    committedAt: z.iso.datetime(),
    wordLanguage: z.literal('en'),
    explanationLanguage: z.enum(['zh-CN', 'en']),
    items: z.array(explorePhraseHistoryItemSchema).length(EXPLORE_PHRASE_ITEM_COUNT)
  })
  .superRefine((batch, context) => {
    // 批内短语按规范化键不得重复：释义或例句不同不使重复短语有效。
    const seen = new Set<string>()
    for (const item of batch.items) {
      if (seen.has(item.normalizedPhrase)) {
        context.addIssue({ code: 'custom', message: 'Duplicate phrase inside batch' })
        return
      }
      seen.add(item.normalizedPhrase)
    }
  })
export type ExplorePhraseBatch = z.infer<typeof explorePhraseHistoryBatchSchema>

// 历史文档：批次按提交顺序排列，最新批次位于数组末尾。
export const explorePhraseHistoryDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  batches: z.array(explorePhraseHistoryBatchSchema).max(EXPLORE_PHRASE_HISTORY_BATCH_LIMIT)
})
export type ExplorePhraseHistoryDocument = z.infer<typeof explorePhraseHistoryDocumentSchema>

// 会话技能报告：批次 + 稳定技能判别字段。用于反馈分派的类型判别。
export const explorePhraseReportSchema = explorePhraseHistoryBatchSchema.extend({
  skillId: z.literal(EXPLORE_PHRASE_SKILL_ID)
})
export type ExplorePhraseReport = z.infer<typeof explorePhraseReportSchema>

export function isExplorePhraseReport(report: unknown): report is ExplorePhraseReport {
  return explorePhraseReportSchema.safeParse(report).success
}
