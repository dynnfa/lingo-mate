import type {
  ExplorePhraseCandidate,
  ExplorePhraseGenerateInput,
  ExplorePhraseGenerator
} from '../learning/explore-phrase/explore-phrase-generator'
import { ExplorePhraseError } from '../learning/explore-phrase/explore-phrase-error'
import {
  explorePhraseTools,
  SUBMIT_EXPLORED_PHRASES_TOOL_NAME,
  validateSubmitExploredPhrasesArguments
} from '../tools/explore-phrase-tools'
import { explorePhraseUserContent } from '../learning/explore-phrase/explore-phrase-generator'
import type { RuntimeModelConfig } from './model-config'
import { classifyModelRequestError, type CreateLlmClient } from './llm-client'
import { isUnsupportedToolCall, parseSingleToolCallResponse } from './tool-protocol'
import { toolRequestParams } from './tool-request-policy'
import { createAbortableOperation } from '../learning/abortable-operation'

const abortableExploreOperation = createAbortableOperation(ExplorePhraseError)

// /explore-phrase 的 LLM 适配器：复用 phrase 技能的单次工具调用模式。每次请求
// 要求恰好调用一次 submit_explored_phrases，不返回普通文本或 JSON 代码块；
// 不支持工具调用的模型返回明确错误，不静默切换为从自然语言解析数据。
// 用量沿用 phrase_analysis operation，由 LlmClient 自动记账。
export class LlmExplorePhraseGenerator implements ExplorePhraseGenerator {
  // 无默认值：调用方（ExplorePhraseModule 通过工厂）持有请求超时策略。
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number,
    private readonly createClient: CreateLlmClient
  ) {}

  async generate(input: ExplorePhraseGenerateInput): Promise<ExplorePhraseCandidate[]> {
    if (!this.config.configured) throw new ExplorePhraseError('MODEL_NOT_CONFIGURED')
    const config = this.config
    return abortableExploreOperation(input.signal, this.timeoutMs, async (signal) => {
      try {
        const client = this.createClient(config)
        const response = await client.complete(
          {
            model: config.modelId,
            messages: [
              { role: 'system', content: input.systemPrompt },
              {
                role: 'user',
                content: explorePhraseUserContent(input)
              }
            ],
            tools: explorePhraseTools(),
            ...toolRequestParams('single-tool-result', config)
          },
          { operation: 'phrase_analysis', timeoutMs: this.timeoutMs, signal }
        )
        const parsed = parseSingleToolCallResponse(response)
        if (parsed.status === 'malformed-response')
          throw new ExplorePhraseError('MODEL_ERROR', { cause: parsed.cause })
        if (parsed.status === 'invalid-tool-call')
          throw new ExplorePhraseError('INVALID_ANALYSIS', { cause: parsed.cause })
        // 只接受本领域工具名。
        if (parsed.toolName !== SUBMIT_EXPLORED_PHRASES_TOOL_NAME) {
          throw new ExplorePhraseError('INVALID_ANALYSIS')
        }
        const candidates = validateSubmitExploredPhrasesArguments(parsed.arguments)
        // 超量超过本次所需数量按协议错误处理；缺额由 Python 图走补足流程。
        if (candidates.length > input.count) {
          throw new ExplorePhraseError('INVALID_ANALYSIS')
        }
        return candidates
      } catch (cause) {
        if (cause instanceof ExplorePhraseError) throw cause
        if (isUnsupportedToolCall(cause)) {
          throw new ExplorePhraseError('TOOL_CALL_NOT_SUPPORTED', { cause })
        }
        throw new ExplorePhraseError(
          classifyModelRequestError(cause) === 'TIMEOUT' ? 'TIMEOUT' : 'MODEL_ERROR',
          { cause }
        )
      }
    })
  }
}
