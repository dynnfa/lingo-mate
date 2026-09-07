import { z } from 'zod'
import type { ChatCompletion } from 'openai/resources/chat/completions'
import { vocabularyAnalysisSchema } from '../../shared/vocabulary'
import { VocabularyError } from '../learning/vocabulary/parse-vocabulary-input'
import type {
  AnalyzeVocabularyInput,
  VocabularyAnalyzer,
  VocabularyAnalysisResult
} from '../learning/vocabulary/vocabulary-analyzer'
import { abortableOperation } from '../learning/vocabulary/abortable-operation'
import { VOCABULARY_PROMPT_VERSION, vocabularySystemMessage } from '../prompt/vocabulary-analysis'
import type { RuntimeModelConfig } from './model-config'
import { createModelClient, classifyModelRequestError } from './remote-language-model'

// The root remains an object (required by structured outputs); the application also
// verifies the status/analysis relationship after parsing the unknown response.
const responseSchema = z.strictObject({
  status: z.enum(['recognized', 'unrecognized']),
  analysis: vocabularyAnalysisSchema.nullable()
})
// Only explicit format-capability errors permit another request. Auth, rate limits,
// invalid schemas and transport failures must retain their original failure semantics.
function isUnsupportedSchema(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { status, message } = error as { status?: unknown; message?: unknown }
  return (
    status === 400 &&
    typeof message === 'string' &&
    /response_format|json_schema/i.test(message) &&
    /(?:not supported|unsupported|unavailable|does not support)/i.test(message)
  )
}

export class LlmVocabularyAnalyzer implements VocabularyAnalyzer {
  private outputMode: 'json_schema' | 'json_object' = 'json_schema'

  // No default: the caller (VocabularyModule via its factory) owns the word
  // timeout policy, keeping a single source for the value.
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number
  ) {}
  async analyze(input: AnalyzeVocabularyInput): Promise<VocabularyAnalysisResult> {
    if (!this.config.configured) throw new VocabularyError('MODEL_NOT_CONFIGURED')
    const config = this.config
    return abortableOperation(input.signal, this.timeoutMs, async (signal) => {
      try {
        const client = createModelClient(config, this.timeoutMs)
        const schema = z.toJSONSchema(responseSchema)
        const request = (mode: 'json_schema' | 'json_object'): Promise<ChatCompletion> =>
          client.chat.completions.create(
            {
              model: config.modelId,
              stream: false,
              messages: [
                {
                  role: 'system',
                  content:
                    vocabularySystemMessage(input.explanationLanguage) +
                    (mode === 'json_object'
                      ? `\nReturn only a JSON object matching this schema: ${JSON.stringify(schema)}\nExample for an unrecognizable term: {"status":"unrecognized","analysis":null}`
                      : '')
                },
                {
                  role: 'user',
                  content: JSON.stringify({ term: input.term, wordLanguage: input.wordLanguage })
                }
              ],
              response_format:
                mode === 'json_object'
                  ? { type: 'json_object' }
                  : {
                      type: 'json_schema',
                      json_schema: {
                        name: 'vocabulary_analysis',
                        strict: true,
                        schema
                      }
                    }
            },
            { signal }
          )
        let result
        const requestedMode = this.outputMode
        try {
          result = await request(requestedMode)
        } catch (cause) {
          if (signal.aborted || requestedMode !== 'json_schema' || !isUnsupportedSchema(cause))
            throw cause
          this.outputMode = 'json_object'
          result = await request('json_object')
        }
        const choice = result.choices?.[0]
        if (
          !choice ||
          choice.finish_reason !== 'stop' ||
          choice.message.refusal ||
          !choice.message.content
        ) {
          throw new VocabularyError('INVALID_ANALYSIS')
        }
        let raw: unknown
        try {
          raw = JSON.parse(choice.message.content)
        } catch (cause) {
          throw new VocabularyError('INVALID_ANALYSIS', { cause })
        }
        const parsed = responseSchema.safeParse(raw)
        if (!parsed.success) throw new VocabularyError('INVALID_ANALYSIS')
        if (parsed.data.status === 'unrecognized' && parsed.data.analysis === null)
          return { status: 'unrecognized' }
        if (parsed.data.status !== 'recognized' || parsed.data.analysis === null)
          throw new VocabularyError('INVALID_ANALYSIS')
        return {
          status: 'recognized',
          analysis: parsed.data.analysis,
          modelId: config.modelId,
          promptVersion: VOCABULARY_PROMPT_VERSION
        }
      } catch (cause) {
        if (cause instanceof VocabularyError) throw cause
        throw new VocabularyError(
          classifyModelRequestError(cause) === 'TIMEOUT' ? 'TIMEOUT' : 'MODEL_ERROR',
          { cause }
        )
      }
    })
  }
}
