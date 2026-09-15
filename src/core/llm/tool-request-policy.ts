import type { ModelProtocol } from '../../shared/models'

// 工具请求兼容策略：根据模型连接信息与调用意图，生成 chat.completions 请求中
// 的工具相关参数。纯函数——只返回请求参数，不发请求、不读配置存储、不改消息、
// 不执行工具；原生协议转换和回放信息维护仍由 Gemini transport 负责。

// 输入只包含策略所需的连接信息字段，不需要 API Key。
export interface ToolRequestPolicyConnection {
  protocol: ModelProtocol
  baseUrl: string
  modelId: string
}

// 两类现有调用意图，不引入循环策略配置：
// - single-tool-result：单次请求恰好返回一个工具调用（vocabulary / phrase）。
// - multi-turn-tool-loop：多轮工具交互循环（synonym / vocabulary-practice）。
export type ToolRequestIntent = 'single-tool-result' | 'multi-turn-tool-loop'

// 可序列化的请求参数片段；thinking / reasoning_effort 为供应商扩展参数。
export interface ToolRequestParams {
  tool_choice: 'auto'
  parallel_tool_calls?: false
  thinking?: { type: 'enabled' }
  reasoning_effort?: 'high'
}

const DEEPSEEK_HOSTNAME = 'api.deepseek.com'
const DEEPSEEK_THINKING_MODEL_PREFIX = 'deepseek-v4-'

// baseUrl 经配置层校验后总是合法；容错解析保证策略不因异常地址抛错。
function hostnameOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return null
  }
}

// DeepSeek V4 默认开启思考模式，该模式拒绝 required tool_choice，改用 auto 并
// 显式请求思考。匹配条件与适用范围保持既有约定：仅单次工具调用启用。
function wantsDeepSeekThinking(connection: ToolRequestPolicyConnection): boolean {
  return (
    hostnameOf(connection.baseUrl) === DEEPSEEK_HOSTNAME &&
    connection.modelId.startsWith(DEEPSEEK_THINKING_MODEL_PREFIX)
  )
}

export function toolRequestParams(
  intent: ToolRequestIntent,
  connection: ToolRequestPolicyConnection
): ToolRequestParams {
  if (intent === 'single-tool-result') {
    // 单次调用不设置 parallel_tool_calls，保持既有请求形状。
    return wantsDeepSeekThinking(connection)
      ? { tool_choice: 'auto', thinking: { type: 'enabled' }, reasoning_effort: 'high' }
      : { tool_choice: 'auto' }
  }
  // 多轮循环按调用顺序回放工具结果：非 Gemini 关闭并行调用，Gemini 无此开关则省略。
  return connection.protocol === 'gemini'
    ? { tool_choice: 'auto' }
    : { tool_choice: 'auto', parallel_tool_calls: false }
}
