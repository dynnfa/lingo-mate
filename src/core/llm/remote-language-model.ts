import { z } from 'zod'
import { conversationSystemMessage } from '../prompt/conversation-prompt'
import { wordConceptSystemMessage } from '../prompt/word-concept'
import type { LanguageModel, StreamReplyInput } from './language-model'
import type { RuntimeModelConfig } from './model-config'
import { ModelRequestError, type CreateLlmClient } from './llm-client'

export const CHAT_REQUEST_TIMEOUT_MS = 120_000

// 只校验本适配器消费的协议字段；允许提供方附带扩展字段。
const chunkSchema = z.object({
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      delta: z.object({ content: z.string().nullable().optional() }),
      finish_reason: z.string().nullable().optional()
    })
  )
})

type ConfiguredModelConfig = RuntimeModelConfig & { configured: true }

// 流式对话适配器：通信生命周期（截止时间、取消、流资源、用量记账）由
// LlmClient 拥有；本层只保留 Prompt 组装、分片协议校验与业务错误映射。
export class RemoteLanguageModel implements LanguageModel {
  constructor(
    private readonly config: ConfiguredModelConfig,
    private readonly timeoutMs: number = CHAT_REQUEST_TIMEOUT_MS,
    private readonly createClient: CreateLlmClient
  ) {}

  async *streamReply(input: StreamReplyInput): AsyncGenerator<string> {
    const client = this.createClient(this.config)
    const systemPrompt =
      input.promptKind === 'word-concept'
        ? wordConceptSystemMessage(input)
        : conversationSystemMessage(input)
    let finished = false
    let hasText = false
    for await (const rawChunk of client.stream(
      {
        model: this.config.modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          ...input.messages.map(({ role, content }) => ({ role, content }))
        ]
      },
      { operation: 'conversation', timeoutMs: this.timeoutMs, signal: input.signal }
    )) {
      const parsed = chunkSchema.safeParse(rawChunk)
      if (!parsed.success) {
        // 不将响应内容包含在错误中。
        throw new ModelRequestError('PROTOCOL', new Error('Invalid chat completion chunk'))
      }
      const choice = parsed.data.choices.find(({ index }) => index === 0)
      if (!choice) continue // usage-only 等不携带正文的分片。
      if (choice.finish_reason != null && choice.finish_reason !== 'stop') {
        throw new ModelRequestError(
          'PROTOCOL',
          new Error('Text completion did not finish normally')
        )
      }
      const delta = choice.delta.content
      // stop 后继续消费到自然结束（尾部用量分片由客户端采集），但正文不再追加。
      if (!finished && typeof delta === 'string' && delta.length > 0) {
        hasText = true
        yield delta
      }
      if (choice.finish_reason === 'stop') {
        finished = true
      }
    }
    if (!finished || !hasText) {
      throw new ModelRequestError('PROTOCOL', new Error('Incomplete text completion'))
    }
  }
}
