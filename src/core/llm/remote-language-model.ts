import OpenAI from 'openai'
import { z } from 'zod'
import { conversationSystemMessage } from '../prompt/conversation-prompt'
import type { LanguageModel, StreamReplyInput } from './language-model'
import type { RuntimeModelConfig } from './model-config'

export type ModelRequestErrorKind =
  'AUTH' | 'MODEL_UNAVAILABLE' | 'TIMEOUT' | 'NETWORK' | 'PROTOCOL' | 'UNKNOWN'

// 错误在产生处保留内部原因；跨进程只传安全错误码，ModelRequestError 不离开 Main。
export class ModelRequestError extends Error {
  constructor(
    readonly kind: ModelRequestErrorKind,
    cause: unknown
  ) {
    super(`Model request failed: ${kind}`, { cause })
    this.name = 'ModelRequestError'
  }
}

type ConfiguredModelConfig = RuntimeModelConfig & { configured: true }

export const CHAT_REQUEST_TIMEOUT_MS = 120_000

// 只校验本适配器消费的协议字段；允许提供方附带 usage 等扩展字段。
const chunkSchema = z.object({
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      delta: z.object({ content: z.string().nullable().optional() }),
      finish_reason: z.string().nullable().optional()
    })
  )
})

// 测试与真实对话共用客户端构建：有限请求时限、禁用自动重试（应用层重试是新请求）。
// 鉴权头不主动转发到跨 origin 重定向目标——undici 的 fetch 遵循 Fetch 规范，
// 跨 origin 重定向时会移除 Authorization 头，无需额外定制。
export function createModelClient(config: ConfiguredModelConfig, timeoutMs: number): OpenAI {
  return new OpenAI({
    baseURL: config.baseUrl,
    // 本地服务可以没有密钥；SDK 要求非空 apiKey，占位值不影响忽略鉴权的服务。
    apiKey: config.apiKey ?? 'lingo-mate-keyless',
    timeout: timeoutMs,
    maxRetries: 0
  })
}

export function classifyModelRequestError(error: unknown): ModelRequestErrorKind {
  if (error instanceof ModelRequestError) return error.kind
  if (error instanceof SyntaxError) return 'PROTOCOL'
  if (error instanceof OpenAI.APIConnectionTimeoutError) return 'TIMEOUT'
  if (error instanceof OpenAI.APIConnectionError) return 'NETWORK'
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401 || error.status === 403) return 'AUTH'
    if (error.status === 404) return 'MODEL_UNAVAILABLE'
  }
  return 'UNKNOWN'
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError')
  }
}

export class RemoteLanguageModel implements LanguageModel {
  private readonly client: OpenAI

  constructor(
    private readonly config: ConfiguredModelConfig,
    private readonly timeoutMs: number = CHAT_REQUEST_TIMEOUT_MS
  ) {
    this.client = createModelClient(config, timeoutMs)
  }

  async *streamReply(input: StreamReplyInput): AsyncGenerator<string> {
    throwIfAborted(input.signal)
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    input.signal.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    // SDK 的请求超时不覆盖 SSE 消费，故截止时间必须持续到生成终态。
    const deadline = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    try {
      const { data: stream, response } = await this.client.chat.completions
        .create(
          {
            model: this.config.modelId,
            stream: true,
            messages: [
              { role: 'system', content: conversationSystemMessage(input) },
              ...input.messages.map(({ role, content }) => ({ role, content }))
            ]
          },
          { signal: controller.signal }
        )
        .withResponse()
      const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (mediaType !== 'text/event-stream') {
        throw new ModelRequestError('PROTOCOL', new Error('Expected an SSE response'))
      }

      let finished = false
      let hasText = false
      for await (const rawChunk of stream) {
        throwIfAborted(controller.signal)
        const parsed = chunkSchema.safeParse(rawChunk)
        if (!parsed.success) {
          // 不将响应内容包含在错误中。
          throw new ModelRequestError('PROTOCOL', new Error('Invalid chat completion chunk'))
        }
        const choice = parsed.data.choices.find(({ index }) => index === 0)
        if (!choice) continue // usage-only 等不携带正文的分片。
        if (choice.finish_reason != null && choice.finish_reason !== 'stop') {
          throw new ModelRequestError(
            'PROTOCOL',
            new Error('Text completion did not finish normally')
          )
        }
        const delta = choice.delta.content
        if (typeof delta === 'string' && delta.length > 0) {
          hasText = true
          yield delta
        }
        if (choice.finish_reason === 'stop') {
          finished = true
          break // 终态后的分片不得改变回复；SDK 会关闭未消费完的流。
        }
      }
      // SDK 可将流式 abort 转为正常迭代结束，必须再次检查自身终态。
      throwIfAborted(controller.signal)
      if (!finished || !hasText) {
        throw new ModelRequestError('PROTOCOL', new Error('Incomplete text completion'))
      }
    } catch (error) {
      if (input.signal.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError')
      }
      if (timedOut) throw new ModelRequestError('TIMEOUT', error)
      if (error instanceof ModelRequestError) throw error
      throw new ModelRequestError(classifyModelRequestError(error), error)
    } finally {
      clearTimeout(deadline)
      input.signal.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }
}
