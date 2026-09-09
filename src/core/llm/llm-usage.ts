// LLM 请求用量账本的记录口径与纯解析逻辑。
// 通信状态表达 SDK 请求与响应消费的结果，与业务校验成败分离；
// usage 以提供方返回为准，缺失值用 NULL 表达未知，不伪造计费用量。

export type LlmRequestOperation =
  | 'conversation'
  | 'vocabulary_analysis'
  | 'phrase_analysis'
  | 'synonym_analysis'
  | 'connection_test'

export type LlmRequestStatus = 'started' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type LlmUsageStatus = 'reported' | 'derived' | 'partial' | 'missing' | 'invalid'

// 解析后的 usage 快照：token 为 null 表示未知（区别于显式 0），
// usageStatus 说明这份快照的数据质量与 total 来源。
export interface ParsedLlmUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  usageStatus: LlmUsageStatus
}

export const MISSING_LLM_USAGE: ParsedLlmUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  usageStatus: 'missing'
}

// 一行用量记录的完整形状，字段与 llm_request_usage 表一一对应。
export interface LlmUsageRecord extends ParsedLlmUsage {
  id: string
  operation: LlmRequestOperation
  // 调用时实际发送的 model 快照；不随设置变化重读。
  modelId: string
  // 提供方响应返回的模型标识；未提供为 null，不推断底层部署模型。
  responseModelId: string | null
  startedAt: number
  finishedAt: number | null
  status: LlmRequestStatus
  // 安全枚举错误码（含 TIMEOUT / CONSUMER_CLOSED 等），不保存原始异常文本。
  errorCode: string | null
}

export interface LlmUsageStart {
  id: string
  operation: LlmRequestOperation
  modelId: string
  startedAt: number
}

// 终态记录：携带全部字段以便开始记录写入失败时按同一 ID 幂等补写。
export type LlmUsageTerminal = LlmUsageRecord

export interface LlmUsageQuery {
  modelId?: string
  fromStartedAt?: number
  toStartedAt?: number
  limit?: number
  offset?: number
}

// Core 只依赖窄仓储接口；SQLite 实现在 src/database，由 Main 组装。
// finish 必须幂等：迟到回调不得改写既有终态，也不得重复插入。
export interface LlmUsageRepository {
  insertStarted(record: LlmUsageStart): void
  finish(record: LlmUsageTerminal): void
  // 启动恢复：把上次进程遗留的 started 标记为 interrupted，返回受影响行数。
  markInterruptedStarted(): number
  list(query: LlmUsageQuery): LlmUsageRecord[]
}

type TokenState = { state: 'absent' } | { state: 'invalid' } | { state: 'ok'; value: number }

// null 与 undefined 表示字段缺失；存在但不是非负安全整数的值视为非法。
function readToken(value: unknown): TokenState {
  if (value === undefined || value === null) return { state: 'absent' }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return { state: 'invalid' }
  }
  return { state: 'ok', value }
}

// 纯函数：把提供方返回的 usage（prompt/completion/total_tokens）解析为记录口径。
// 任何输入都不抛错——usage 数据质量问题不能中止正文消费或令回复失败。
export function parseLlmUsage(raw: unknown): ParsedLlmUsage {
  if (typeof raw !== 'object' || raw === null) return MISSING_LLM_USAGE

  const source = raw as Record<string, unknown>
  const prompt = readToken(source.prompt_tokens)
  const completion = readToken(source.completion_tokens)
  const total = readToken(source.total_tokens)
  if (prompt.state === 'absent' && completion.state === 'absent' && total.state === 'absent') {
    return MISSING_LLM_USAGE
  }

  const inputTokens = prompt.state === 'ok' ? prompt.value : null
  const outputTokens = completion.state === 'ok' ? completion.value : null
  const totalTokens = total.state === 'ok' ? total.value : null
  const hasInvalidField =
    prompt.state === 'invalid' || completion.state === 'invalid' || total.state === 'invalid'

  if (inputTokens !== null && outputTokens !== null) {
    if (totalTokens !== null) {
      // 提供方 total 与 input/output 不一致时保留原值并标记 invalid，不静默修正。
      return {
        inputTokens,
        outputTokens,
        totalTokens,
        usageStatus: totalTokens === inputTokens + outputTokens ? 'reported' : 'invalid'
      }
    }
    // 只有 total 缺失（而非非法）时才允许相加派生，并标记 derived。
    if (hasInvalidField) {
      return { inputTokens, outputTokens, totalTokens: null, usageStatus: 'invalid' }
    }
    if (!Number.isSafeInteger(inputTokens + outputTokens)) {
      return { inputTokens, outputTokens, totalTokens: null, usageStatus: 'invalid' }
    }
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      usageStatus: 'derived'
    }
  }

  // 局部有效字段保留；存在即非全缺失，缺失部分不推导。
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    usageStatus: hasInvalidField ? 'invalid' : 'partial'
  }
}
