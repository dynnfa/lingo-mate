import { z } from 'zod'
import type { RuntimeModelConfig } from '../../llm/model-config'
import { classifyModelRequestError, type CreateLlmClient } from '../../llm/llm-client'
import type { TargetLanguage } from '../../../shared/preferences'
import { sentenceContentSchema } from '../../../shared/sentence'
import { SentenceError } from './sentence-repository'

export interface SentenceTranslator {
  translate(input: {
    sourceText: string
    targetLanguage: TargetLanguage
    systemPrompt: string
    signal: AbortSignal
  }): Promise<string>
}
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({ content: z.string().nullish(), refusal: z.string().nullish() })
      })
    )
    .min(1)
})
const resultSchema = z.strictObject({ translation: sentenceContentSchema.shape.translation })
export class LlmSentenceTranslator implements SentenceTranslator {
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly createClient: CreateLlmClient
  ) {}
  async translate(input: Parameters<SentenceTranslator['translate']>[0]): Promise<string> {
    if (!this.config.configured) throw new SentenceError('MODEL_NOT_CONFIGURED')
    input.signal.throwIfAborted()
    try {
      const response = await this.createClient(this.config).complete(
        {
          model: this.config.modelId,
          messages: [
            { role: 'system', content: input.systemPrompt },
            {
              role: 'user',
              content: JSON.stringify({
                sourceText: input.sourceText,
                targetLanguage: input.targetLanguage
              })
            }
          ]
        },
        { operation: 'sentence_translation', timeoutMs: 60_000, signal: input.signal }
      )
      input.signal.throwIfAborted()
      const parsed = responseSchema.safeParse(response)
      if (!parsed.success) throw new SentenceError('INVALID_ANALYSIS', { cause: parsed.error })
      const choice = parsed.data.choices[0]
      if (
        choice.finish_reason !== 'stop' ||
        choice.message.refusal ||
        !choice.message.content?.trim()
      )
        throw new SentenceError('INVALID_ANALYSIS')
      try {
        return resultSchema.parse(JSON.parse(choice.message.content)).translation
      } catch (cause) {
        throw new SentenceError('INVALID_ANALYSIS', { cause })
      }
    } catch (cause) {
      input.signal.throwIfAborted()
      if (cause instanceof SentenceError) throw cause
      throw new SentenceError(
        classifyModelRequestError(cause) === 'TIMEOUT' ? 'TIMEOUT' : 'MODEL_ERROR',
        { cause }
      )
    }
  }
}
