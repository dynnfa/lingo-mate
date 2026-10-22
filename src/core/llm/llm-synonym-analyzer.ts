import { z } from 'zod'
import type { SynonymAnalyzer, SynonymModelTurn } from '../learning/synonym/synonym-analyzer'
import { SynonymError } from '../learning/synonym/parse-synonym-input'
import { synonymTools } from '../tools/synonym-tools'
import type { RuntimeModelConfig } from './model-config'
import { classifyModelRequestError, type CreateLlmClient } from './llm-client'
import { isUnsupportedToolCall } from './tool-protocol'
import { toolRequestParams } from './tool-request-policy'

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('tool_calls'),
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
            .min(1)
        })
      })
    )
    .min(1)
})

export class LlmSynonymAnalyzer implements SynonymAnalyzer {
  private client?: ReturnType<CreateLlmClient>
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number,
    private readonly createClient: CreateLlmClient
  ) {}
  async analyze(input: Parameters<SynonymAnalyzer['analyze']>[0]): Promise<SynonymModelTurn> {
    if (!this.config.configured) throw new SynonymError('MODEL_NOT_CONFIGURED')
    try {
      input.signal.throwIfAborted()
      const response = await (this.client ??= this.createClient(this.config)).complete(
        {
          model: this.config.modelId,
          messages: structuredClone(input.messages),
          tools: synonymTools(),
          ...toolRequestParams('multi-turn-tool-loop', this.config)
        },
        { operation: 'synonym_analysis', signal: input.signal, timeoutMs: this.timeoutMs }
      )
      input.signal.throwIfAborted()
      const parsed = responseSchema.safeParse(response)
      if (!parsed.success) throw new SynonymError('INVALID_ANALYSIS', { cause: parsed.error })
      const message = parsed.data.choices[0].message
      if (message.content || message.refusal) throw new SynonymError('INVALID_ANALYSIS')
      return { message, canCorrectParallel: this.config.protocol === 'gemini' }
    } catch (cause) {
      if (cause instanceof SynonymError) throw cause
      if (isUnsupportedToolCall(cause)) throw new SynonymError('TOOL_CALL_NOT_SUPPORTED', { cause })
      throw new SynonymError(
        classifyModelRequestError(cause) === 'TIMEOUT' ? 'TIMEOUT' : 'MODEL_ERROR',
        { cause }
      )
    }
  }
}
