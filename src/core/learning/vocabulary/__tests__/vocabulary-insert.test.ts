import { describe, expect, it } from 'vitest'
import { VocabularyError } from '../parse-vocabulary-input'
import {
  assertValidInsertCommand,
  buildVocabularyInsertCommand,
  insertToolArgumentsSchema,
  unrecognizedToolArgumentsSchema,
  validateInsertArguments,
  vocabularyInsertBindingSchema,
  vocabularyInsertTools,
  VOCABULARY_INSERT_SQL,
  VOCABULARY_INSERT_TOOL_NAME,
  VOCABULARY_UNRECOGNIZED_TOOL_NAME,
  type VocabularyInsertCommand
} from '../vocabulary-insert'
import { content as sampleContent } from './fixtures'

type InsertArguments = Record<string, unknown>
const insertArguments = (overrides: Record<string, unknown> = {}): InsertArguments => ({
  term: 'apple',
  phonetic: ['/ˈæpəl/'],
  meaning: '苹果，一种水果。',
  concept: '通常指作为食物的苹果果实。',
  example_sentences: ['I ate an apple after lunch.'],
  ...overrides
})

describe('vocabulary insert contract', () => {
  it('exposes only structured learning content to the model', () => {
    const tools = vocabularyInsertTools()
    expect(tools.map((tool) => tool.function.name).sort()).toEqual(
      ['insert_vocabulary', 'vocabulary_unrecognized'].sort()
    )
    const insert = tools.find((tool) => tool.function.name === VOCABULARY_INSERT_TOOL_NAME)!
    expect('strict' in insert.function).toBe(false)
    const schema = insert.function.parameters as {
      properties: Record<string, unknown>
      additionalProperties: boolean
      required: string[]
    }
    expect(schema.properties).not.toHaveProperty('sql')
    expect(JSON.stringify(tools)).not.toContain(VOCABULARY_INSERT_SQL)
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['term', 'phonetic', 'meaning', 'concept', 'example_sentences'])
    expect(VOCABULARY_INSERT_SQL).toContain('INSERT INTO vocabulary')
    expect(VOCABULARY_INSERT_SQL).not.toContain('ON CONFLICT')
  })
  it('validates tool arguments into insert content and rejects replacements', () => {
    const validated = validateInsertArguments(insertArguments(), 'apple')
    expect(validated).toEqual({
      term: 'apple',
      phonetic: ['/ˈæpəl/'],
      meaning: '苹果，一种水果。',
      concept: '通常指作为食物的苹果果实。',
      exampleSentences: ['I ate an apple after lunch.']
    })
    // 词项替换：模型不得把目标词换成其他词。
    expect(() =>
      validateInsertArguments(
        insertArguments({
          term: 'banana'
        }),
        'apple'
      )
    ).toThrow('INVALID_ANALYSIS')
  })
  it.each([
    insertArguments({ sql: `${VOCABULARY_INSERT_SQL}; DROP TABLE vocabulary` }),
    insertArguments({ sql: 'UPDATE vocabulary SET term = @term' }),
    insertArguments({ sql: VOCABULARY_INSERT_SQL.toUpperCase() }),
    insertArguments({ extra: true }),
    insertArguments({ id: 'model-uuid' }),
    insertArguments({ model_id: 'model' }),
    insertArguments({ prompt_version: 'v0' }),
    insertArguments({ created_at: 'now' }),
    insertArguments({ phonetic: 'apple' }),
    ...[
      [],
      [''],
      ['/riːd/', 'read'],
      ['/unknown/'],
      Array(11).fill('/a/'),
      ['/' + 'a'.repeat(199) + '/']
    ].map((phonetic) => insertArguments({ phonetic })),
    insertArguments({ phonetic: '/?/' }),
    insertArguments({
      phonetic: '/x'.repeat(101) + '/'
    }),
    insertArguments({ meaning: '' }),
    insertArguments({ meaning: '  ' }),
    insertArguments({ concept: 'x'.repeat(2001) }),
    insertArguments({
      example_sentences: 'not json'
    }),
    insertArguments({
      example_sentences: '"a sentence"'
    }),
    insertArguments({
      example_sentences: '[]'
    }),
    insertArguments({
      example_sentences: Array(4).fill('A sentence.')
    }),
    insertArguments({
      example_sentences: ['']
    }),
    insertArguments({
      example_sentences: ['x'.repeat(501)]
    })
  ])('rejects illegal or oversized arguments %#', (value) => {
    expect(() => validateInsertArguments(value, 'apple')).toThrow(VocabularyError)
  })
  it('keeps the wire schema strict for protocol violations including array semantics', () => {
    // 工具参数的形状违规（语句、系统字段、额外字段、内容上限）在 schema 层拒绝。
    for (const value of [
      insertArguments({ sql: `${VOCABULARY_INSERT_SQL}; DROP TABLE vocabulary` }),
      insertArguments({ sql: 'UPDATE vocabulary SET term = @term' }),
      insertArguments({ extra: true }),
      insertArguments({ id: 'model-uuid' }),
      insertArguments({ model_id: 'model' }),
      insertArguments({ meaning: '' }),
      insertArguments({
        concept: 'x'.repeat(2001)
      })
    ]) {
      expect(insertToolArgumentsSchema.safeParse(value).success).toBe(false)
    }
    // 例句必须直接提供数组，不能提供 JSON 字符串。
    expect(
      insertToolArgumentsSchema.safeParse(
        insertArguments({
          example_sentences: 'not json'
        })
      ).success
    ).toBe(false)
  })
  it('accepts authentic IPA in brackets and multiple sentences', () => {
    const validated = validateInsertArguments(
      insertArguments({
        phonetic: ['[ˈæpəl]'],
        example_sentences: ['One.', 'Two.']
      }),
      'apple'
    )
    expect(validated.phonetic).toEqual(['[ˈæpəl]'])
    expect(validated.exampleSentences).toEqual(['One.', 'Two.'])
  })
  it('accepts only the unrecognized reason enum', () => {
    expect(unrecognizedToolArgumentsSchema.safeParse({ reason: 'UNRECOGNIZED' }).success).toBe(true)
    for (const value of [
      { reason: 'NOT_ENGLISH' },
      { reason: 'UNRECOGNIZED', note: 'text' },
      {},
      { reason: 'UNRECOGNIZED', sql: VOCABULARY_INSERT_SQL }
    ]) {
      expect(unrecognizedToolArgumentsSchema.safeParse(value).success).toBe(false)
    }
  })
  it('builds commands with system fields and re-validates them at the boundary', () => {
    const command = buildVocabularyInsertCommand(sampleContent('apple'), {
      id: '11111111-1111-4111-8111-111111111111',
      modelId: 'configured-model',
      promptVersion: 'vocabulary-sql-v1',
      createdAt: '2026-09-07T00:00:00.000Z'
    })
    expect(command.sql).toBe(VOCABULARY_INSERT_SQL)
    expect(command.parameters.example_sentences).toBe('["I ate an apple after lunch."]')
    expect(vocabularyInsertBindingSchema.parse(command.parameters)).toBeTruthy()
    expect(() => assertValidInsertCommand(command)).not.toThrow()

    const tampered = structuredClone(command)
    tampered.sql = 'DELETE FROM vocabulary'
    expect(() => assertValidInsertCommand(tampered)).toThrow('Illegal vocabulary insert statement')

    const missingField: VocabularyInsertCommand = {
      ...command,
      parameters: {
        ...command.parameters,
        model_id: undefined as unknown as VocabularyInsertCommand['parameters']['model_id']
      }
    }
    expect(() => assertValidInsertCommand(missingField)).toThrow(
      'Invalid vocabulary insert bindings'
    )

    const badSentences = structuredClone(command)
    badSentences.parameters.example_sentences = 'not json'
    expect(() => assertValidInsertCommand(badSentences)).toThrow(
      'Invalid vocabulary insert bindings'
    )
  })
  it('exposes the same tool name constants used by the adapter', () => {
    expect(VOCABULARY_INSERT_TOOL_NAME).toBe('insert_vocabulary')
    expect(VOCABULARY_UNRECOGNIZED_TOOL_NAME).toBe('vocabulary_unrecognized')
  })
})

it('accepts multiple IPA variants and serializes them losslessly', () => {
  const phonetic = ['/riːd/', '/rɛd/']
  const result = validateInsertArguments(insertArguments({ term: 'read', phonetic }), 'read')
  expect(result.phonetic).toEqual(phonetic)
  const command = buildVocabularyInsertCommand(result, {
    id: '11111111-1111-4111-8111-111111111111',
    modelId: 'model',
    promptVersion: 'test',
    createdAt: '2026-09-18T00:00:00.000Z'
  })
  expect(JSON.parse(command.parameters.phonetic)).toEqual(phonetic)
})

it('rejects malformed phonetic JSON at the storage boundary', () => {
  const command = buildVocabularyInsertCommand(sampleContent(), {
    id: '11111111-1111-4111-8111-111111111111',
    modelId: 'model',
    promptVersion: 'test',
    createdAt: '2026-09-18T00:00:00.000Z'
  })
  for (const phonetic of ['/riːd/', '[]', '["/riːd/", 1]', '["word"]']) {
    expect(() =>
      assertValidInsertCommand({ ...command, parameters: { ...command.parameters, phonetic } })
    ).toThrow('Invalid vocabulary insert bindings')
  }
})
