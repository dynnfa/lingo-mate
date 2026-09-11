import { z } from 'zod'
import { SentencePracticeError } from '../learning/sentence-practice/parse-sentence-practice-input'
import type { RuntimeModelConfig } from './model-config'
import { classifyModelRequestError, type CreateLlmClient } from './llm-client'

// 造句练习两次模型调用共用的一次性 JSON 完成辅助：单次请求、无工具
// 调用；空响应、拒绝回答、非法 JSON 与协议字段缺失都按无效分析处理。
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          reasoning_content: z.string().optional()
        })
      })
    )
    .min(1)
})

export async function completeSentencePracticeJson<T>(input: {
  config: RuntimeModelConfig
  createClient: CreateLlmClient
  timeoutMs: number
  signal: AbortSignal
  systemMessage: string
  userPayload: unknown
  parse: (value: unknown) => T
}): Promise<T> {
  if (!input.config.configured) throw new SentencePracticeError('MODEL_NOT_CONFIGURED')
  const client = input.createClient(input.config)
  try {
    if (input.signal.aborted) throw new SentencePracticeError('CANCELLED')
    const response = await client.complete(
      {
        model: input.config.modelId,
        messages: [
          { role: 'system', content: input.systemMessage },
          { role: 'user', content: JSON.stringify(input.userPayload) }
        ]
      },
      // 造句练习与词汇练习共用词库与审查口径，不新增数据库 operation 枚举。
      { operation: 'vocabulary_analysis', signal: input.signal, timeoutMs: input.timeoutMs }
    )
    if (input.signal.aborted) throw new SentencePracticeError('CANCELLED')
    const parsed = responseSchema.safeParse(response)
    if (!parsed.success)
      throw new SentencePracticeError('INVALID_ANALYSIS', { cause: parsed.error })
    const choice = parsed.data.choices[0]
    const content = choice.message.content
    if (
      choice.message.refusal ||
      choice.finish_reason !== 'stop' ||
      typeof content !== 'string' ||
      !content.trim()
    ) {
      throw new SentencePracticeError('INVALID_ANALYSIS')
    }
    let value: unknown
    try {
      value = JSON.parse(content.trim())
    } catch (cause) {
      throw new SentencePracticeError('INVALID_ANALYSIS', { cause })
    }
    return input.parse(value)
  } catch (cause) {
    if (cause instanceof SentencePracticeError) throw cause
    throw new SentencePracticeError(
      classifyModelRequestError(cause) === 'TIMEOUT' ? 'TIMEOUT' : 'MODEL_ERROR',
      { cause }
    )
  }
}
