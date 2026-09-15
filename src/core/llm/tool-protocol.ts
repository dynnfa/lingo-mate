import { z } from 'zod'

// 工具调用适配器共用的 chat.completions 响应协议检查与能力错误识别。
// 只校验适配器消费的协议字段；允许提供方附带扩展字段。多轮循环保留各自的
// 完整响应 schema（需要非空 call id 与 reasoning 字段），不复用此处的单次检查。

const toolCompletionResponseSchema = z.object({
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
export function isUnsupportedToolCall(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { status, message } = error as { status?: unknown; message?: unknown }
  return (
    status === 400 &&
    typeof message === 'string' &&
    /tools?|tool_choice/i.test(message) &&
    /(?:not supported|unsupported|unavailable|does not support|invalid)/i.test(message)
  )
}

// 单次工具响应（一次请求、恰好一个 function 调用）的解析结果。失败分两类，
// 对应调用方既有的错误契约：malformed-response 是响应不符合 chat.completions
// 基础结构（调用方按模型错误处理）；invalid-tool-call 是结构有效但不满足单次
// 工具语义或 arguments 不是合法 JSON（调用方按无效分析处理）。
export type SingleToolCallParseResult =
  | { status: 'parsed'; toolName: string; arguments: unknown }
  | { status: 'malformed-response'; cause: unknown }
  | { status: 'invalid-tool-call'; cause?: unknown }

// 纯解析函数：不发 complete 请求、不接收 executor 或领域回调、不返回消息转录。
// 读取首个 choice；允许的空 content / refusal 规则与既有单次分析器一致。工具名
// 白名单与参数 schema 校验留给各领域分析器。
export function parseSingleToolCallResponse(response: unknown): SingleToolCallParseResult {
  type ResponseChoice = NonNullable<z.infer<typeof toolCompletionResponseSchema>['choices']>[number]
  let choice: ResponseChoice | undefined
  try {
    choice = toolCompletionResponseSchema.parse(response).choices?.[0]
  } catch (cause) {
    return { status: 'malformed-response', cause }
  }
  const toolCalls = choice?.message.tool_calls ?? []
  if (
    !choice ||
    choice.finish_reason !== 'tool_calls' ||
    choice.message.refusal ||
    (choice.message.content ?? '') !== '' ||
    toolCalls.length !== 1
  ) {
    return { status: 'invalid-tool-call' }
  }
  try {
    return {
      status: 'parsed',
      toolName: toolCalls[0].function.name,
      arguments: JSON.parse(toolCalls[0].function.arguments)
    }
  } catch (cause) {
    return { status: 'invalid-tool-call', cause }
  }
}
