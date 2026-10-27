import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { z } from 'zod'
import { VocabularyPracticeError } from './parse-vocabulary-practice-input'
import type {
  VocabularyPracticeModel,
  VocabularyPracticeModelMessage
} from './vocabulary-practice-reviewer'
import { vocabularyPracticeTools } from './vocabulary-practice-tools'
import type { RuntimeModelConfig } from '../../llm/model-config'
import { classifyModelRequestError, type CreateLlmClient } from '../../llm/llm-client'
import { isUnsupportedToolCall } from '../../llm/tool-protocol'
import { toolRequestParams } from '../../llm/tool-request-policy'

// 工具调用可附带说明文本；只有正常结束且无工具调用时才解析最终反馈。
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          reasoning_content: z.string().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                type: z.literal('function'),
                function: z.object({ name: z.string(), arguments: z.string() })
              })
            )
            .optional()
        })
      })
    )
    .min(1)
})

// One provider request only. Python drives all turns and supplies the full prompt.
export class LlmVocabularyPracticeReviewer implements VocabularyPracticeModel {
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number,
    private readonly createClient: CreateLlmClient
  ) {}

  async complete(input: {
    messages: ChatCompletionMessageParam[]
    signal: AbortSignal
  }): Promise<VocabularyPracticeModelMessage> {
    if (!this.config.configured) throw new VocabularyPracticeError('MODEL_NOT_CONFIGURED')
    input.signal.throwIfAborted()
    try {
      const response = await this.createClient(this.config).complete(
        {
          model: this.config.modelId,
          messages: input.messages,
          tools: vocabularyPracticeTools(),
          ...toolRequestParams('multi-turn-tool-loop', this.config)
        },
        { operation: 'vocabulary_analysis', signal: input.signal, timeoutMs: this.timeoutMs }
      )
      input.signal.throwIfAborted()
      const parsed = responseSchema.safeParse(response)
      if (!parsed.success)
        throw new VocabularyPracticeError('INVALID_ANALYSIS', { cause: parsed.error })
      const choice = parsed.data.choices[0]
      const message = choice.message
      const calls = message.tool_calls ?? []
      if (message.refusal || choice.finish_reason !== (calls.length ? 'tool_calls' : 'stop'))
        throw new VocabularyPracticeError('INVALID_ANALYSIS')
      return { ...message, role: 'assistant' }
    } catch (cause) {
      input.signal.throwIfAborted()
      if (cause instanceof VocabularyPracticeError) throw cause
      if (isUnsupportedToolCall(cause))
        throw new VocabularyPracticeError('TOOL_CALL_NOT_SUPPORTED', { cause })
      throw new VocabularyPracticeError(
        classifyModelRequestError(cause) === 'TIMEOUT' ? 'TIMEOUT' : 'MODEL_ERROR',
        { cause }
      )
    }
  }
}
