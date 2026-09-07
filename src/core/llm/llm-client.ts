import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming
} from 'openai/resources/chat/completions'
import type { LlmRequestOperation, ParsedLlmUsage } from './llm-usage'
import { MISSING_LLM_USAGE, parseLlmUsage } from './llm-usage'
import type { LlmUsageRecorder } from './llm-usage-recorder'

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

export interface LlmClientConfig {
  baseUrl: string
  apiKey: string | undefined
}

// Main 组装的客户端工厂：按配置快照创建 LlmClient，复用同一 recorder。
export type CreateLlmClient = (config: LlmClientConfig) => Pick<LlmClient, 'complete' | 'stream'>

// 调用上下文：operation 必填；model_id 由客户端从实际发送参数读取。
export interface LlmRequestContext {
  operation: LlmRequestOperation
  timeoutMs: number
  signal?: AbortSignal
}

// 交给业务层的分片：客户端先解析 usage/model，业务层不读取也不保存 usage。
export type LlmStreamChunk = Omit<ChatCompletionChunk, 'usage'>

type NonStreamingParams = Omit<ChatCompletionCreateParamsNonStreaming, 'stream'>
type StreamingParams = Omit<ChatCompletionCreateParamsStreaming, 'stream'>

interface InterruptionOutcome {
  status: 'failed' | 'cancelled'
  errorCode: string | null
  error: Error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError')
  }
}

// 外部取消原因不导入具体领域错误类型：deadline 语义按取消原因的
// code 字段识别（如词汇任务期限），用户取消一律视为普通取消。
function isDeadlineAbortReason(signal: AbortSignal | undefined): boolean {
  const reason: unknown = signal?.reason
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { code?: unknown }).code === 'TIMEOUT'
  )
}

// 每次请求的通信守卫：统一持有截止时间、外部取消监听与转发用 AbortController。
// interrupted Promise 保证即使底层传输忽略 abort，等待也能及时结束并收尾。
class RequestGuard {
  readonly controller = new AbortController()
  interruption: InterruptionOutcome | undefined
  private readonly deadline: ReturnType<typeof setTimeout>
  private readonly externalSignal: AbortSignal | undefined
  private readonly onExternalAbort = (): void =>
    this.interrupt(isDeadlineAbortReason(this.externalSignal))
  private rejectInterrupted!: (error: Error) => void
  private readonly interrupted = new Promise<never>((_, reject) => {
    this.rejectInterrupted = reject
  })

  constructor(
    external: AbortSignal | undefined,
    timeoutMs: number,
    private readonly onInterrupt: (outcome: InterruptionOutcome) => void
  ) {
    this.externalSignal = external
    this.deadline = setTimeout(() => this.interrupt(true), timeoutMs)
    external?.addEventListener('abort', this.onExternalAbort, { once: true })
  }

  private interrupt(timedOut: boolean): void {
    if (this.interruption) return
    const cause = this.externalSignal?.reason ?? new Error('LLM request deadline reached')
    const outcome: InterruptionOutcome = timedOut
      ? { status: 'failed', errorCode: 'TIMEOUT', error: new ModelRequestError('TIMEOUT', cause) }
      : {
          status: 'cancelled',
          errorCode: null,
          error: new DOMException('The operation was aborted', 'AbortError')
        }
    // 在事件发生时固定终态并收尾，即使生成器正暂停在 yield。
    this.interruption = outcome
    this.onInterrupt(outcome)
    this.release()
    this.rejectInterrupted(outcome.error)
  }

  // 恢复消费时先检查终态，避免中断后再向底层请求分片或接受迟到结果。
  async awaitInterruptible<T>(operation: () => Promise<T>): Promise<T> {
    this.throwIfInterrupted()
    const result = await Promise.race([operation(), this.interrupted])
    this.throwIfInterrupted()
    return result
  }

  private throwIfInterrupted(): void {
    if (this.interruption) throw this.interruption.error
  }

  release(): void {
    clearTimeout(this.deadline)
    this.externalSignal?.removeEventListener('abort', this.onExternalAbort)
    this.controller.abort()
  }
}

function withoutUsage(chunk: ChatCompletionChunk): LlmStreamChunk {
  const visible: Record<string, unknown> = { ...chunk }
  delete visible.usage
  return visible as LlmStreamChunk
}

// 统一 LLM 通信入口：所有生产代码中的 chat.completions.create 只出现在这里。
// 每次实际 SDK 调用自动记账（started → 终态），业务适配器只传调用上下文。
export class LlmClient {
  private readonly sdk: OpenAI

  // SDK 自动重试关闭：应用层重试是一次新的 SDK 调用，对应新的账本记录。
  // 鉴权头不主动转发到跨 origin 重定向目标——undici 的 fetch 遵循 Fetch 规范，
  // 跨 origin 重定向时会移除 Authorization 头，无需额外定制。
  // 本地服务可以没有密钥；SDK 要求非空 apiKey，占位值不影响忽略鉴权的服务。
  constructor(
    config: LlmClientConfig,
    private readonly recorder: LlmUsageRecorder
  ) {
    this.sdk = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey ?? 'lingo-mate-keyless',
      maxRetries: 0
    })
  }

  // 非流式请求：completion 返回后先完成通信记账，再把响应交给业务层校验。
  // 业务校验抛错不反转已完成的记录。
  async complete(params: NonStreamingParams, context: LlmRequestContext): Promise<ChatCompletion> {
    throwIfAborted(context.signal)
    const recording = this.recorder.begin(context.operation, params.model)
    const settle = (
      status: 'completed' | 'failed' | 'cancelled',
      errorCode: string | null,
      usage: ParsedLlmUsage,
      responseModelId: string | null
    ): void => {
      recording.finish({ status, errorCode, finishedAt: Date.now(), responseModelId, usage })
    }

    const guard = new RequestGuard(context.signal, context.timeoutMs, (outcome) => {
      settle(outcome.status, outcome.errorCode, MISSING_LLM_USAGE, null)
    })

    try {
      try {
        const completion = await guard.awaitInterruptible(() =>
          this.sdk.chat.completions.create(
            { ...params, stream: false as const },
            { signal: guard.controller.signal, timeout: context.timeoutMs }
          )
        )
        const responseModel =
          typeof completion?.model === 'string' && completion.model !== '' ? completion.model : null
        settle('completed', null, parseLlmUsage(completion?.usage), responseModel)
        return completion
      } catch (cause) {
        const outcome = this.classifyFailure(guard, cause)
        settle(outcome.status, outcome.errorCode, MISSING_LLM_USAGE, null)
        throw outcome.error
      }
    } finally {
      guard.release()
    }
  }

  // 流式请求：客户端负责 SDK 调用与整个响应消费周期（含 SSE 媒体类型校验、
  // 尾部用量分片、超时与取消）。自然结束才记 completed；业务提前关闭迭代器记
  // cancelled / CONSUMER_CLOSED。业务层不得 break——stop 后应继续消费到自然结束。
  async *stream(
    params: StreamingParams,
    context: LlmRequestContext
  ): AsyncGenerator<LlmStreamChunk, void, void> {
    throwIfAborted(context.signal)
    const recording = this.recorder.begin(context.operation, params.model)
    // usage 与 response model 是请求内快照：后续有效报告更新快照，
    // 缺失报告不清空已有用量，重复报告不累计。
    const snapshot: { usage: ParsedLlmUsage; responseModel: string | null } = {
      usage: MISSING_LLM_USAGE,
      responseModel: null
    }
    const settle = (
      status: 'completed' | 'failed' | 'cancelled',
      errorCode: string | null
    ): void => {
      recording.finish({
        status,
        errorCode,
        finishedAt: Date.now(),
        responseModelId: snapshot.responseModel,
        usage: snapshot.usage
      })
    }

    const guard = new RequestGuard(context.signal, context.timeoutMs, (outcome) => {
      settle(outcome.status, outcome.errorCode)
    })

    try {
      try {
        const { data: stream, response } = await guard.awaitInterruptible(() =>
          this.sdk.chat.completions
            .create(
              {
                ...params,
                stream: true as const,
                stream_options: { include_usage: true }
              },
              { signal: guard.controller.signal, timeout: context.timeoutMs }
            )
            .withResponse()
        )
        const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        if (mediaType !== 'text/event-stream') {
          throw new ModelRequestError('PROTOCOL', new Error('Expected an SSE response'))
        }

        const iterator = stream[Symbol.asyncIterator]()
        try {
          while (true) {
            const next = await guard.awaitInterruptible(() => iterator.next())
            if (next.done) break
            const chunk = next.value
            if (typeof chunk.model === 'string' && chunk.model !== '') {
              snapshot.responseModel = chunk.model
            }
            if (chunk.usage != null) {
              const parsed = parseLlmUsage(chunk.usage)
              if (parsed.usageStatus !== 'missing') snapshot.usage = parsed
            }
            yield withoutUsage(chunk)
          }
        } finally {
          // 中途退出时释放底层流；不为尾部用量在关闭后继续后台消费。
          this.releaseIterator(iterator)
        }
        // SDK 可将流式 abort 转为正常迭代结束：自然结束也必须复核自身终态。
        if (guard.interruption) throw guard.interruption.error
        settle('completed', null)
      } catch (cause) {
        const outcome = this.classifyFailure(guard, cause)
        settle(outcome.status, outcome.errorCode)
        throw outcome.error
      }
    } finally {
      guard.release()
      // 业务层 break/return/throw 提前关闭迭代器时的兜底终态；
      // 已收尾的记录（自然结束或异常）不受影响。
      settle('cancelled', 'CONSUMER_CLOSED')
    }
  }

  private releaseIterator(iterator: AsyncIterator<ChatCompletionChunk>): void {
    try {
      const closing = iterator.return?.()
      if (closing) void closing.catch(() => {})
    } catch {
      // 释放失败不影响请求收尾
    }
  }

  // 把通信异常映射为账本终态与业务可见错误。超时与领域截止时间记 failed/TIMEOUT，
  // 用户取消记 cancelled；其余失败按安全错误码分类。原始错误保留为 cause。
  private classifyFailure(guard: RequestGuard, cause: unknown): InterruptionOutcome {
    if (guard.interruption) return guard.interruption
    if (cause instanceof ModelRequestError) {
      return { status: 'failed', errorCode: cause.kind, error: cause }
    }
    const kind = classifyModelRequestError(cause)
    const error = cause instanceof Error ? cause : new ModelRequestError(kind, cause)
    return { status: 'failed', errorCode: kind, error }
  }
}
