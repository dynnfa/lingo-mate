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
import { isUnsupportedToolCall, parseSingleToolCallResponse } from './tool-protocol'
import { toolRequestParams } from './tool-request-policy'

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
            ...toolRequestParams('single-tool-result', config)
          },
          { operation: 'phrase_analysis', timeoutMs: this.timeoutMs, signal }
        )
        const parsed = parseSingleToolCallResponse(response)
        if (parsed.status === 'malformed-response')
          throw new PhraseError('MODEL_ERROR', { cause: parsed.cause })
        if (parsed.status === 'invalid-tool-call')
          throw new PhraseError('INVALID_ANALYSIS', { cause: parsed.cause })
        // 剩余为领域规则：只接受本领域工具名，不提取正文中的 SQL。
        if (
          parsed.toolName !== PHRASE_INSERT_TOOL_NAME &&
          parsed.toolName !== PHRASE_UNRECOGNIZED_TOOL_NAME
        ) {
          throw new PhraseError('INVALID_ANALYSIS')
        }
        if (parsed.toolName === PHRASE_UNRECOGNIZED_TOOL_NAME) {
          if (!phraseUnrecognizedToolArgumentsSchema.safeParse(parsed.arguments).success) {
            throw new PhraseError('INVALID_ANALYSIS')
          }
          return { status: 'unrecognized' }
        }
        return {
          status: 'insert',
          content: validatePhraseInsertArguments(parsed.arguments, input.phrase),
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
