import { z } from 'zod'
import {
  SENTENCE_PRACTICE_HINT_COUNT_MAX,
  SENTENCE_PRACTICE_HINT_COUNT_MIN,
  sentencePracticeHintSchema
} from '../../../shared/sentence-practice'
import { SentencePracticeError } from './parse-sentence-practice-input'
import type {
  SentenceHint,
  SentenceHintGenerator,
  SentencePracticeHintModel
} from './sentence-practice-models'
import type { RuntimeModelConfig } from '../../llm/model-config'
import type { CreateLlmClient } from '../../llm/llm-client'
import { completeSentencePracticeJson } from './llm-sentence-practice-completion'

// 模型最终输出：正好一个含 hints 数组的 JSON 对象。
const hintsPayloadSchema = z.strictObject({
  hints: z
    .array(sentencePracticeHintSchema)
    .min(SENTENCE_PRACTICE_HINT_COUNT_MIN)
    .max(SENTENCE_PRACTICE_HINT_COUNT_MAX)
})

// 造句提示生成适配器：单次完成调用，本地严格校验条数、ID 归属与覆盖。
export class LlmSentencePracticeHintGenerator implements SentencePracticeHintModel {
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number,
    private readonly createClient: CreateLlmClient
  ) {}

  async generate(
    input: Parameters<SentenceHintGenerator['generate']>[0] & { systemPrompt: string }
  ): Promise<SentenceHint[]> {
    const entryIds = new Set(input.entries.map((entry) => entry.entryId))
    return completeSentencePracticeJson({
      config: this.config,
      createClient: this.createClient,
      timeoutMs: this.timeoutMs,
      signal: input.signal,
      systemMessage: input.systemPrompt,
      userPayload: { entries: input.entries },
      parse: (value) => {
        const parsed = hintsPayloadSchema.safeParse(value)
        if (!parsed.success)
          throw new SentencePracticeError('INVALID_ANALYSIS', { cause: parsed.error })
        // 引用 ID 必须属于本轮，且所有提示合计覆盖全部词条。
        const covered = new Set<string>()
        for (const hint of parsed.data.hints) {
          for (const entryId of hint.entryIds) {
            if (!entryIds.has(entryId)) throw new SentencePracticeError('INVALID_ANALYSIS')
            covered.add(entryId)
          }
        }
        if (covered.size !== entryIds.size) throw new SentencePracticeError('INVALID_ANALYSIS')
        return parsed.data.hints
      }
    })
  }
}
