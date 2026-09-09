import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { z } from 'zod'
import type { SynonymAnalyzer } from '../learning/synonym/synonym-analyzer'
import { SynonymError } from '../learning/synonym/parse-synonym-input'
import { synonymTools } from '../tools/synonym-tools'
import { synonymSystemMessage } from '../prompt/synonym-analysis'
import type { RuntimeModelConfig } from './model-config'
import { classifyModelRequestError, type CreateLlmClient } from './llm-client'
import { isUnsupportedToolCall } from './tool-protocol'

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
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number,
    private readonly createClient: CreateLlmClient,
    private readonly maxRounds = 52
  ) {}
  async analyze(input: Parameters<SynonymAnalyzer['analyze']>[0]): Promise<void> {
    if (!this.config.configured) throw new SynonymError('MODEL_NOT_CONFIGURED')
    const client = this.createClient(this.config)
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: synonymSystemMessage(input.explanationLanguage) },
      { role: 'user', content: JSON.stringify({ word: input.word, wordLanguage: 'en' }) }
    ]
    const ids = new Set<string>()
    let correctedParallelTurn = false
    try {
      for (let round = 0; round < this.maxRounds; round++) {
        if (input.signal.aborted) throw new SynonymError('CANCELLED')
        const response = await client.complete(
          {
            model: this.config.modelId,
            messages,
            tools: synonymTools(),
            tool_choice: 'auto',
            ...(this.config.protocol === 'gemini' ? {} : { parallel_tool_calls: false })
          },
          { operation: 'synonym_analysis', signal: input.signal, timeoutMs: this.timeoutMs }
        )
        if (input.signal.aborted) throw new SynonymError('CANCELLED')
        const parsed = responseSchema.safeParse(response)
        if (!parsed.success) throw new SynonymError('INVALID_ANALYSIS', { cause: parsed.error })
        const message = parsed.data.choices[0].message
        if (message.content || message.refusal) throw new SynonymError('INVALID_ANALYSIS')
        for (const call of message.tool_calls) {
          if (ids.has(call.id)) throw new SynonymError('INVALID_ANALYSIS')
          ids.add(call.id)
        }
        if (message.tool_calls.length !== 1) {
          // Gemini has no parallel_tool_calls switch. Reject the whole turn before
          // executing anything, and allow one correction within the existing round limit.
          if (this.config.protocol !== 'gemini' || correctedParallelTurn)
            throw new SynonymError('INVALID_ANALYSIS')
          correctedParallelTurn = true
          messages.push({ ...message, role: 'assistant' })
          for (const call of message.tool_calls) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ error: 'SINGLE_TOOL_CALL_REQUIRED' })
            })
          }
          continue
        }
        const call = message.tool_calls[0]
        let args: unknown
        try {
          args = JSON.parse(call.function.arguments)
        } catch (cause) {
          throw new SynonymError('INVALID_ANALYSIS', { cause })
        }
        const outcome = input.executor.execute(call.function.name, args)
        // Preserve call ids and provider reasoning fields for multi-turn tool protocols.
        messages.push({ ...message, role: 'assistant' })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(outcome.result)
        })
        if (outcome.terminal) return
      }
      throw new SynonymError('ROUND_LIMIT')
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
