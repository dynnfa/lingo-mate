import {
  sentencePracticeReviewSchema,
  type SentencePracticeReview
} from '../../shared/sentence-practice'
import { SentencePracticeError } from '../learning/sentence-practice/parse-sentence-practice-input'
import type {
  SentencePracticeReviewer,
  SentencePracticeReviewModel
} from '../learning/sentence-practice/sentence-practice-models'
import type { RuntimeModelConfig } from './model-config'
import type { CreateLlmClient } from './llm-client'
import { completeSentencePracticeJson } from './llm-sentence-practice-completion'

// 造句点评适配器：单次完成调用，本地按 schema 与本轮词条校验点评，
// 未使用判正确、语法结论与问题列表矛盾等自相矛盾结果按无效分析处理。
export class LlmSentencePracticeReviewer implements SentencePracticeReviewModel {
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number,
    private readonly createClient: CreateLlmClient
  ) {}

  async review(
    input: Parameters<SentencePracticeReviewer['review']>[0] & { systemPrompt: string }
  ): Promise<SentencePracticeReview> {
    const entryIds = new Set(input.entries.map((entry) => entry.entryId))
    return completeSentencePracticeJson({
      config: this.config,
      createClient: this.createClient,
      timeoutMs: this.timeoutMs,
      signal: input.signal,
      systemMessage: input.systemPrompt,
      userPayload: { entries: input.entries, hints: input.hints, answer: input.answer },
      parse: (value) => {
        const parsed = sentencePracticeReviewSchema.safeParse(value)
        if (!parsed.success)
          throw new SentencePracticeError('INVALID_ANALYSIS', { cause: parsed.error })
        // wordUsage 必须与本轮词条一一对应：拒绝未知或重复 ID。
        const usageIds = new Set(parsed.data.wordUsage.map((usage) => usage.entryId))
        if (usageIds.size !== entryIds.size || [...usageIds].some((id) => !entryIds.has(id))) {
          throw new SentencePracticeError('INVALID_ANALYSIS')
        }
        return parsed.data
      }
    })
  }
}
