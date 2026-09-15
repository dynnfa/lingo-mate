import { VocabularyError } from '../learning/vocabulary/parse-vocabulary-input'
import {
  validateInsertArguments,
  VOCABULARY_INSERT_TOOL_NAME,
  VOCABULARY_UNRECOGNIZED_TOOL_NAME,
  vocabularyInsertTools,
  unrecognizedToolArgumentsSchema
} from '../learning/vocabulary/vocabulary-insert'
import type {
  AnalyzeVocabularyInput,
  VocabularyAnalyzer,
  VocabularyAnalysisResult
} from '../learning/vocabulary/vocabulary-analyzer'
import { abortableOperation } from '../learning/vocabulary/abortable-operation'
import { VOCABULARY_PROMPT_VERSION, vocabularySystemMessage } from '../prompt/vocabulary-analysis'
import type { RuntimeModelConfig } from './model-config'
import { classifyModelRequestError, type CreateLlmClient } from './llm-client'
import { isUnsupportedToolCall, parseSingleToolCallResponse } from './tool-protocol'
import { toolRequestParams } from './tool-request-policy'

export class LlmVocabularyAnalyzer implements VocabularyAnalyzer {
  // No default: the caller (VocabularyModule via its factory) owns the word
  // timeout policy, keeping a single source for the value.
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number,
    private readonly createClient: CreateLlmClient
  ) {}
  async analyze(input: AnalyzeVocabularyInput): Promise<VocabularyAnalysisResult> {
    if (!this.config.configured) throw new VocabularyError('MODEL_NOT_CONFIGURED')
    const config = this.config
    return abortableOperation(input.signal, this.timeoutMs, async (signal) => {
      try {
        const client = this.createClient(config)
        const response = await client.complete(
          {
            model: config.modelId,
            messages: [
              {
                role: 'system',
                content: vocabularySystemMessage(input.explanationLanguage)
              },
              {
                role: 'user',
                content: JSON.stringify({ term: input.term, wordLanguage: input.wordLanguage })
              }
            ],
            tools: vocabularyInsertTools(),
            ...toolRequestParams('single-tool-result', config)
          },
          { operation: 'vocabulary_analysis', timeoutMs: this.timeoutMs, signal }
        )
        const parsed = parseSingleToolCallResponse(response)
        if (parsed.status === 'malformed-response')
          throw new VocabularyError('MODEL_ERROR', { cause: parsed.cause })
        if (parsed.status === 'invalid-tool-call')
          throw new VocabularyError('INVALID_ANALYSIS', { cause: parsed.cause })
        // 剩余为领域规则：只接受本领域工具名，不提取正文中的 SQL。
        if (
          parsed.toolName !== VOCABULARY_INSERT_TOOL_NAME &&
          parsed.toolName !== VOCABULARY_UNRECOGNIZED_TOOL_NAME
        ) {
          throw new VocabularyError('INVALID_ANALYSIS')
        }
        if (parsed.toolName === VOCABULARY_UNRECOGNIZED_TOOL_NAME) {
          if (!unrecognizedToolArgumentsSchema.safeParse(parsed.arguments).success) {
            throw new VocabularyError('INVALID_ANALYSIS')
          }
          return { status: 'unrecognized' }
        }
        return {
          status: 'insert',
          content: validateInsertArguments(parsed.arguments, input.term),
          modelId: config.modelId,
          promptVersion: VOCABULARY_PROMPT_VERSION
        }
      } catch (cause) {
        if (cause instanceof VocabularyError) throw cause
        if (isUnsupportedToolCall(cause)) {
          throw new VocabularyError('TOOL_CALL_NOT_SUPPORTED', { cause })
        }
        throw new VocabularyError(
          classifyModelRequestError(cause) === 'TIMEOUT' ? 'TIMEOUT' : 'MODEL_ERROR',
          { cause }
        )
      }
    })
  }
}
