import { z } from 'zod'
import { VocabularyError } from './parse-vocabulary-input'

// 应用内部固定的参数化 INSERT，不暴露给模型，也不接受模型提供的 SQL。
export const VOCABULARY_INSERT_SQL =
  'INSERT INTO vocabulary (id, term, phonetic, meaning, concept, example_sentences, model_id, prompt_version, created_at) VALUES (@id, @term, @phonetic, @meaning, @concept, @example_sentences, @model_id, @prompt_version, @created_at)' as const

export const VOCABULARY_INSERT_TOOL_NAME = 'insert_vocabulary'
export const VOCABULARY_UNRECOGNIZED_TOOL_NAME = 'vocabulary_unrecognized'
export const VOCABULARY_UNRECOGNIZED_REASON = 'UNRECOGNIZED'

// 例句在词表中以 JSON 编码的字符串数组存储；应用层约定 1–3 条非空例句。
export const exampleSentenceListSchema = z.array(z.string().min(1).max(500)).min(1).max(3)
export type ExampleSentenceList = z.infer<typeof exampleSentenceListSchema>

// 音标保留旧分析协议的真实性检查：斜杠或方括号包裹、内部含字母、无占位内容。
const phoneticSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^(\/[^/]+\/|\[[^[\]]+\])$/)
  .superRefine((phonetic, context) => {
    const phonemes = phonetic.slice(1, -1).trim()
    if (!/\p{Letter}/u.test(phonemes) || /[?\d]|unknown|unavailable|n\/a/i.test(phonemes)) {
      context.addIssue({ code: 'custom', message: 'Invalid IPA transcription' })
    }
  })

// 模型通过 insert_vocabulary 返回的参数。四个系统字段由应用补入，不接受模型传入。
export const insertToolArgumentsSchema = z.strictObject({
  term: z.string().min(1).max(4000),
  phonetic: phoneticSchema,
  meaning: z.string().trim().min(1).max(2000),
  concept: z.string().trim().min(1).max(2000),
  example_sentences: exampleSentenceListSchema
})

export const unrecognizedToolArgumentsSchema = z.strictObject({
  reason: z.literal(VOCABULARY_UNRECOGNIZED_REASON)
})

// 已通过全部校验的学习内容；例句保留数组形态，入库时由程序序列化。
export interface VocabularyInsertContent {
  term: string
  phonetic: string
  meaning: string
  concept: string
  exampleSentences: ExampleSentenceList
}

export function validateInsertArguments(
  raw: unknown,
  expectedTerm: string
): VocabularyInsertContent {
  const parsed = insertToolArgumentsSchema.safeParse(raw)
  if (!parsed.success || parsed.data.term !== expectedTerm) {
    throw new VocabularyError('INVALID_ANALYSIS')
  }
  const parameters = parsed.data
  return {
    term: parameters.term,
    phonetic: parameters.phonetic,
    meaning: parameters.meaning,
    concept: parameters.concept,
    exampleSentences: parameters.example_sentences
  }
}

// 完整绑定参数（含系统字段）。数据库执行边界用它对命令做最终校验。
export const vocabularyInsertBindingSchema = z
  .strictObject({
    id: z.uuid(),
    term: z.string().min(1).max(4000),
    phonetic: z.string().min(1).max(200),
    meaning: z.string().min(1).max(2000),
    concept: z.string().min(1).max(2000),
    example_sentences: z.string().min(2).max(2000),
    model_id: z.string().min(1).max(200),
    prompt_version: z.string().min(1).max(100),
    created_at: z.iso.datetime()
  })
  .superRefine((binding, context) => {
    if (
      !exampleSentenceListSchema.safeParse(parseJsonOrUndefined(binding.example_sentences)).success
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid example_sentences encoding' })
    }
  })
export type VocabularyInsertBinding = z.infer<typeof vocabularyInsertBindingSchema>

// SQL 与绑定参数共同构成可执行命令；正文中出现的引号、换行或分号始终只作为参数数据。
export interface VocabularyInsertCommand {
  sql: string
  parameters: VocabularyInsertBinding
}

export function buildVocabularyInsertCommand(
  content: VocabularyInsertContent,
  system: { id: string; modelId: string; promptVersion: string; createdAt: string }
): VocabularyInsertCommand {
  const command: VocabularyInsertCommand = {
    sql: VOCABULARY_INSERT_SQL,
    parameters: {
      id: system.id,
      term: content.term,
      phonetic: content.phonetic,
      meaning: content.meaning,
      concept: content.concept,
      example_sentences: JSON.stringify(content.exampleSentences),
      model_id: system.modelId,
      prompt_version: system.promptVersion,
      created_at: system.createdAt
    }
  }
  assertValidInsertCommand(command)
  return command
}

// 数据库执行边界的最终校验：语句必须与常量精确一致，绑定参数必须完整合法。
export function assertValidInsertCommand(command: VocabularyInsertCommand): void {
  if (command.sql !== VOCABULARY_INSERT_SQL) {
    throw new Error('Illegal vocabulary insert statement')
  }
  if (!vocabularyInsertBindingSchema.safeParse(command.parameters).success) {
    throw new Error('Invalid vocabulary insert bindings')
  }
}

// 请求内声明的 function tool 形状；llm 适配器把它直接传给 chat.completions.create。
export interface VocabularyToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export function vocabularyInsertTools(): VocabularyToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: VOCABULARY_INSERT_TOOL_NAME,
        description:
          'Insert the analyzed English vocabulary term into the local vocabulary table. ' +
          'Supply learning content only; the application handles storage. ' +
          'The application supplies id, model_id, prompt_version and created_at itself.',
        parameters: {
          type: 'object',
          properties: {
            term: { type: 'string', minLength: 1, maxLength: 4000 },
            phonetic: { type: 'string', minLength: 3, maxLength: 200 },
            meaning: { type: 'string', minLength: 1, maxLength: 2000 },
            concept: { type: 'string', minLength: 1, maxLength: 2000 },
            example_sentences: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 500 },
              minItems: 1,
              maxItems: 3
            }
          },
          required: ['term', 'phonetic', 'meaning', 'concept', 'example_sentences'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: VOCABULARY_UNRECOGNIZED_TOOL_NAME,
        description:
          'Report that the term is not recognizable English, or that a required value ' +
          '(especially the IPA transcription) cannot be supplied reliably.',
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string', enum: [VOCABULARY_UNRECOGNIZED_REASON] } },
          required: ['reason'],
          additionalProperties: false
        }
      }
    }
  ]
}

function parseJsonOrUndefined(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
