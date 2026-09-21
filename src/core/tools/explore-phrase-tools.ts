import { z } from 'zod'
import {
  EXPLORE_PHRASE_EXAMPLE_MAX_LENGTH,
  EXPLORE_PHRASE_EXPLANATION_MAX_LENGTH,
  EXPLORE_PHRASE_ITEM_COUNT,
  EXPLORE_PHRASE_MAX_LENGTH
} from '../../shared/explore-phrase'
import { ExplorePhraseError } from '../learning/explore-phrase/explore-phrase-error'
import type { ExplorePhraseCandidate } from '../learning/explore-phrase/explore-phrase-generator'

// /explore-phrase 仅暴露一个白名单工具：模型通过 submit_explored_phrases
// 提交候选内容（且只提供三个内容字段）；executionId、身份、时间、语言快照
// 与规范化键全部由应用生成，不接受模型指定。

export const SUBMIT_EXPLORED_PHRASES_TOOL_NAME = 'submit_explored_phrases'

// 三个模型字段都是单行文本；含换行的条目视为不合格。
const singleLineContent = (maxLength: number, field: string): z.ZodType<string> =>
  z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine((value) => !/[\r\n]/u.test(value), { message: `${field} must be a single line` })

// 单个请求的工具数组上限为 10 项、下限为 1 项；最终批次必须恰好 10 项
//（由模块层裁决，超量超过本次所需数量按协议错误处理）。
export const submitExploredPhrasesArgumentsSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        phrase: singleLineContent(EXPLORE_PHRASE_MAX_LENGTH, 'phrase'),
        explanation: singleLineContent(EXPLORE_PHRASE_EXPLANATION_MAX_LENGTH, 'explanation'),
        example: singleLineContent(EXPLORE_PHRASE_EXAMPLE_MAX_LENGTH, 'example')
      })
    )
    .min(1)
    .max(EXPLORE_PHRASE_ITEM_COUNT)
})

export function validateSubmitExploredPhrasesArguments(raw: unknown): ExplorePhraseCandidate[] {
  const parsed = submitExploredPhrasesArgumentsSchema.safeParse(raw)
  if (!parsed.success) throw new ExplorePhraseError('INVALID_ANALYSIS', { cause: parsed.error })
  return parsed.data.items
}

// 请求内声明的 function tool 形状；llm 适配器把它直接传给 chat.completions.create。
export interface ExplorePhraseToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export function explorePhraseTools(): ExplorePhraseToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: SUBMIT_EXPLORED_PHRASES_TOOL_NAME,
        description:
          'Submit the generated English phrases for this exploration round. ' +
          'Supply learning content only; the application validates, stores and ' +
          'decides when the batch is committed.',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              minItems: 1,
              maxItems: EXPLORE_PHRASE_ITEM_COUNT,
              items: {
                type: 'object',
                properties: {
                  phrase: {
                    type: 'string',
                    minLength: 1,
                    maxLength: EXPLORE_PHRASE_MAX_LENGTH
                  },
                  explanation: {
                    type: 'string',
                    minLength: 1,
                    maxLength: EXPLORE_PHRASE_EXPLANATION_MAX_LENGTH
                  },
                  example: {
                    type: 'string',
                    minLength: 1,
                    maxLength: EXPLORE_PHRASE_EXAMPLE_MAX_LENGTH
                  }
                },
                required: ['phrase', 'explanation', 'example'],
                additionalProperties: false
              }
            }
          },
          required: ['items'],
          additionalProperties: false
        }
      }
    }
  ]
}
