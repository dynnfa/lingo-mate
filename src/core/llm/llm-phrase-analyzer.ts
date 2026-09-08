import { PhraseError } from '../learning/phrase/parse-phrase-input'
import {
  validatePhraseInsertArguments,
  PHRASE_INSERT_TOOL_NAME,
  PHRASE_UNRECOGNIZED_TOOL_NAME,
  phraseInsertTools,
  phraseUnrecognizedToolArgumentsSchema
} from '../tools/phrase-tools'
import type {
  AnalyzePhraseInput,
  PhraseAnalyzer,
  PhraseAnalysisResult
} from '../learning/phrase/phrase-analyzer'
import { abortablePhraseOperation } from '../learning/phrase/abortable-operation'
import { PHRASE_PROMPT_VERSION, phraseSystemMessage } from '../prompt/phrase-analysis'
import type { RuntimeModelConfig } from './model-config'
import { classifyModelRequestError, type CreateLlmClient } from './llm-client'
import { isUnsupportedToolCall, toolCompletionResponseSchema } from './tool-protocol'

export class LlmPhraseAnalyzer implements PhraseAnalyzer {
  // 无默认值：调用方（PhraseModule 通过工厂）持有单项超时策略，保持单一来源。
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number,
    private readonly createClient: CreateLlmClient
  ) {}
  async analyze(input: AnalyzePhraseInput): Promise<PhraseAnalysisResult> {
    if (!this.config.configured) throw new PhraseError('MODEL_NOT_CONFIGURED')
    const config = this.config
    return abortablePhraseOperation(input.signal, this.timeoutMs, async (signal) => {
      try {
        const client = this.createClient(config)
        // 与 vocabulary 适配器保持同一兼容策略：DeepSeek V4 思考模式拒绝
        // required tool_choice，使用 auto；响应仍须通过单工具与入库参数校验。
        const useDeepSeekThinking =
          new URL(config.baseUrl).hostname === 'api.deepseek.com' &&
          config.modelId.startsWith('deepseek-v4-')
        const response = await client.complete(
          {
            model: config.modelId,
            messages: [
              {
                role: 'system',
                content: phraseSystemMessage(input.explanationLanguage)
              },
              {
                role: 'user',
                content: JSON.stringify({ phrase: input.phrase, wordLanguage: input.wordLanguage })
              }
            ],
            tools: phraseInsertTools(),
            tool_choice: 'auto',
            ...(useDeepSeekThinking
              ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' as const }
              : {})
          },
          { operation: 'phrase_analysis', timeoutMs: this.timeoutMs, signal }
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
          throw new PhraseError('INVALID_ANALYSIS')
        }
        const call = toolCalls[0]
        if (
          call.function.name !== PHRASE_INSERT_TOOL_NAME &&
          call.function.name !== PHRASE_UNRECOGNIZED_TOOL_NAME
        ) {
          throw new PhraseError('INVALID_ANALYSIS')
        }
        let argumentsJson: unknown
        try {
          argumentsJson = JSON.parse(call.function.arguments)
        } catch (cause) {
          throw new PhraseError('INVALID_ANALYSIS', { cause })
        }
        if (call.function.name === PHRASE_UNRECOGNIZED_TOOL_NAME) {
          if (!phraseUnrecognizedToolArgumentsSchema.safeParse(argumentsJson).success) {
            throw new PhraseError('INVALID_ANALYSIS')
          }
          return { status: 'unrecognized' }
        }
        return {
          status: 'insert',
          content: validatePhraseInsertArguments(argumentsJson, input.phrase),
          modelId: config.modelId,
          promptVersion: PHRASE_PROMPT_VERSION
        }
      } catch (cause) {
        if (cause instanceof PhraseError) throw cause
        if (isUnsupportedToolCall(cause)) {
          throw new PhraseError('TOOL_CALL_NOT_SUPPORTED', { cause })
        }
        throw new PhraseError(
          classifyModelRequestError(cause) === 'TIMEOUT' ? 'TIMEOUT' : 'MODEL_ERROR',
          { cause }
        )
      }
    })
  }
}
