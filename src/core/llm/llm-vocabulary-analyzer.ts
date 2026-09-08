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
import { isUnsupportedToolCall, toolCompletionResponseSchema } from './tool-protocol'

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
        // DeepSeek V4 默认开启思考模式，该模式拒绝 required tool_choice。
        // 使用 auto 兼容思考与工具调用；响应仍须通过单工具与入库参数校验。
        const useDeepSeekThinking =
          new URL(config.baseUrl).hostname === 'api.deepseek.com' &&
          config.modelId.startsWith('deepseek-v4-')
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
            tool_choice: 'auto',
            ...(useDeepSeekThinking
              ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' as const }
              : {})
          },
          { operation: 'vocabulary_analysis', timeoutMs: this.timeoutMs, signal }
        )
        const choice = toolCompletionResponseSchema.parse(response).choices?.[0]
        const toolCalls = choice?.message.tool_calls ?? []
        // 非空正文、多个工具、未知工具或无工具响应均为协议错误，不提取正文中的 SQL。
        if (
          !choice ||
          choice.finish_reason !== 'tool_calls' ||
          choice.message.refusal ||
          (choice.message.content ?? '') !== '' ||
          toolCalls.length !== 1
        ) {
          throw new VocabularyError('INVALID_ANALYSIS')
        }
        const call = toolCalls[0]
        if (
          call.function.name !== VOCABULARY_INSERT_TOOL_NAME &&
          call.function.name !== VOCABULARY_UNRECOGNIZED_TOOL_NAME
        ) {
          throw new VocabularyError('INVALID_ANALYSIS')
        }
        let argumentsJson: unknown
        try {
          argumentsJson = JSON.parse(call.function.arguments)
        } catch (cause) {
          throw new VocabularyError('INVALID_ANALYSIS', { cause })
        }
        if (call.function.name === VOCABULARY_UNRECOGNIZED_TOOL_NAME) {
          if (!unrecognizedToolArgumentsSchema.safeParse(argumentsJson).success) {
            throw new VocabularyError('INVALID_ANALYSIS')
          }
          return { status: 'unrecognized' }
        }
        return {
          status: 'insert',
          content: validateInsertArguments(argumentsJson, input.term),
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
