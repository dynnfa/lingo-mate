import type { SupportedLocale, TargetLanguage } from '../../shared/preferences'
import type { ChannelIntentRecognizer, ChannelIntentResult } from '../channels/channel-types'
import {
  channelIntentSystemMessage,
  channelIntentTools,
  NO_INTENT_TOOL_NAME,
  parseSaveIntentArguments,
  SAVE_INTENT_TOOL_NAME,
  UNCLEAR_INTENT_TOOL_NAME
} from '../prompt/channel-intent'
import type { RuntimeModelConfig } from './model-config'
import type { CreateLlmClient } from './llm-client'
import { isUnsupportedToolCall, parseSingleToolCallResponse } from './tool-protocol'
import { toolRequestParams } from './tool-request-policy'

export interface ChannelIntentInput {
  text: string
  outputLanguage: SupportedLocale
  targetLanguage: TargetLanguage
  signal: AbortSignal
}

// 渠道意图识别：单工具调用协议，无写入能力；协议错误上抛，
// 由渠道模块按失败返回安全错误提示。
export class LlmChannelIntentRecognizer implements ChannelIntentRecognizer {
  constructor(
    private readonly config: RuntimeModelConfig,
    private readonly timeoutMs: number,
    private readonly createClient: CreateLlmClient
  ) {}

  async recognize(input: ChannelIntentInput): Promise<ChannelIntentResult> {
    if (!this.config.configured) throw new Error('MODEL_NOT_CONFIGURED')
    const client = this.createClient(this.config)
    const response = await client.complete(
      {
        model: this.config.modelId,
        messages: [
          { role: 'system', content: channelIntentSystemMessage(input.outputLanguage) },
          {
            role: 'user',
            content: JSON.stringify({
              message: input.text,
              targetLanguage: input.targetLanguage
            })
          }
        ],
        tools: channelIntentTools(),
        ...toolRequestParams('single-tool-result', this.config)
      },
      // 用量并入 conversation 操作：意图识别属于外部会话消息处理的一部分。
      { operation: 'conversation', timeoutMs: this.timeoutMs, signal: input.signal }
    )
    const parsed = parseSingleToolCallResponse(response)
    if (parsed.status !== 'parsed') {
      throw new Error(`Channel intent protocol error: ${parsed.status}`)
    }
    if (parsed.toolName === SAVE_INTENT_TOOL_NAME) {
      return { status: 'save', words: parseSaveIntentArguments(parsed.arguments) }
    }
    if (parsed.toolName === UNCLEAR_INTENT_TOOL_NAME) {
      return { status: 'clarify' }
    }
    if (parsed.toolName === NO_INTENT_TOOL_NAME) {
      return { status: 'none' }
    }
    throw new Error(`Unexpected channel intent tool: ${parsed.toolName}`)
  }
}

// 重新导出便于装配侧统一处理未支持工具调用错误。
export { isUnsupportedToolCall }
