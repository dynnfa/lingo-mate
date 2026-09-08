import { z } from 'zod'
import {
  PHRASE_EXAMPLE_MAX_LENGTH,
  PHRASE_EXPLANTATION_MAX_LENGTH,
  PHRASE_MAX_LENGTH
} from '../../shared/phrase'
import { PhraseError } from '../learning/phrase/parse-phrase-input'

// /phrase 技能仅暴露两个白名单工具。字段名沿用需求拼写 explantation；
// SQL 固定封装在数据库仓储中，模型只能提供内容绑定值。

export const PHRASE_INSERT_TOOL_NAME = 'insert_phrase'
export const PHRASE_UNRECOGNIZED_TOOL_NAME = 'phrase_unrecognized'
export const PHRASE_UNRECOGNIZED_REASON = 'UNRECOGNIZED'

// 模型通过 insert_phrase 返回的参数；phrase 必须与本地发送的当前规范化短语一致。
export const phraseInsertToolArgumentsSchema = z.strictObject({
  phrase: z.string().min(1).max(PHRASE_MAX_LENGTH),
  explantation: z.string().trim().min(1).max(PHRASE_EXPLANTATION_MAX_LENGTH),
  example: z.string().trim().min(1).max(PHRASE_EXAMPLE_MAX_LENGTH)
})

export const phraseUnrecognizedToolArgumentsSchema = z.strictObject({
  reason: z.literal(PHRASE_UNRECOGNIZED_REASON)
})

// 已通过全部校验的学习内容；仓储只接收该内容对象，不接收 SQL 字符串。
export interface PhraseInsertContent {
  phrase: string
  explantation: string
  example: string
}

export function validatePhraseInsertArguments(
  raw: unknown,
  expectedPhrase: string
): PhraseInsertContent {
  const parsed = phraseInsertToolArgumentsSchema.safeParse(raw)
  if (!parsed.success || parsed.data.phrase !== expectedPhrase) {
    throw new PhraseError('INVALID_ANALYSIS')
  }
  return {
    phrase: parsed.data.phrase,
    explantation: parsed.data.explantation,
    example: parsed.data.example
  }
}

// 数据库执行边界的最终校验：内容对象必须结构完整且满足表约束。
export const phraseInsertBindingSchema = z.strictObject({
  phrase: z.string().min(1).max(PHRASE_MAX_LENGTH),
  explantation: z.string().trim().min(1).max(PHRASE_EXPLANTATION_MAX_LENGTH),
  example: z.string().trim().min(1).max(PHRASE_EXAMPLE_MAX_LENGTH)
})
export type PhraseInsertBinding = z.infer<typeof phraseInsertBindingSchema>

export function assertValidPhraseInsertContent(content: PhraseInsertContent): void {
  if (!phraseInsertBindingSchema.safeParse(content).success) {
    throw new Error('Invalid phrase insert bindings')
  }
}

// 请求内声明的 function tool 形状；llm 适配器把它直接传给 chat.completions.create。
export interface PhraseToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export function phraseInsertTools(): PhraseToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: PHRASE_INSERT_TOOL_NAME,
        description:
          'Insert the analyzed English phrase into the local phrase table. ' +
          'Supply learning content only; the application stores it and decides ' +
          'when the batch is committed.',
        parameters: {
          type: 'object',
          properties: {
            phrase: { type: 'string', minLength: 1, maxLength: PHRASE_MAX_LENGTH },
            explantation: {
              type: 'string',
              minLength: 1,
              maxLength: PHRASE_EXPLANTATION_MAX_LENGTH
            },
            example: { type: 'string', minLength: 1, maxLength: PHRASE_EXAMPLE_MAX_LENGTH }
          },
          required: ['phrase', 'explantation', 'example'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: PHRASE_UNRECOGNIZED_TOOL_NAME,
        description:
          'Report that the input cannot be explained reliably as an English phrase ' +
          'or idiomatic expression.',
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string', enum: [PHRASE_UNRECOGNIZED_REASON] } },
          required: ['reason'],
          additionalProperties: false
        }
      }
    }
  ]
}
