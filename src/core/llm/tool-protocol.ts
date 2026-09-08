import { z } from 'zod'

// 会话技能适配器共用的 chat.completions 响应协议与能力错误识别。
// 只校验适配器消费的协议字段；允许提供方附带扩展字段。

export const toolCompletionResponseSchema = z.object({
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
