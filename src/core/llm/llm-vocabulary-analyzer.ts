import { z } from 'zod'
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
import { createModelClient, classifyModelRequestError } from './remote-language-model'

// 只校验本适配器消费的协议字段；允许提供方附带 usage 等扩展字段。
const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                type: z.literal('function'),
                function: z.object({ name: z.string(), arguments: z.string() })
              })
            )
            .optional()
        })
      })
    )
    .optional()
})

// 只把明确的工具协议能力错误映射为 TOOL_CALL_NOT_SUPPORTED；鉴权、限流、
// 网络与其他 400 保持原有失败语义，不做文本回退。
function isUnsupportedToolCall(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { status, message } = error as { status?: unknown; message?: unknown }
  return (
    status === 400 &&
    typeof message === 'string' &&
    /tools?|tool_choice/i.test(message) &&
    /(?:not supported|unsupported|unavailable|does not support|invalid)/i.test(message)
  )
}

export class LlmVocabularyAnalyzer implements VocabularyAnalyzer {
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
        // DeepSeek V4 默认开启思考模式，该模式拒绝 required tool_choice。
        // 使用 auto 兼容思考与工具调用；响应仍须通过单工具与入库参数校验。
        const useDeepSeekThinking =
          new URL(config.baseUrl).hostname === 'api.deepseek.com' &&
          config.modelId.startsWith('deepseek-v4-')
        const response = await client.chat.completions.create(
          {
            model: config.modelId,
            stream: false,
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
            tool_choice: useDeepSeekThinking ? 'auto' : 'required',
            ...(useDeepSeekThinking
              ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' as const }
              : {})
          },
          { signal }
        )
        const choice = completionSchema.parse(response).choices?.[0]
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
