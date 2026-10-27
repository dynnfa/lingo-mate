import { describe, expect, it } from 'vitest'
import { PhraseError } from '../parse-phrase-input'
import {
  assertValidPhraseInsertContent,
  phraseUnrecognizedToolArgumentsSchema,
  validatePhraseInsertArguments,
  phraseInsertTools,
  PHRASE_INSERT_TOOL_NAME
} from '../phrase-tools'

type InsertArguments = Record<string, unknown>
const insertArguments = (overrides: Record<string, unknown> = {}): InsertArguments => ({
  phrase: 'look forward to',
  explantation: '期待，盼望（某件将发生的事）。',
  example: 'I look forward to hearing from you.',
  ...overrides
})

describe('phrase insert contract', () => {
  it('exposes only structured learning content to the model', () => {
    const tools = phraseInsertTools()
    expect(tools.map((tool) => tool.function.name).sort()).toEqual(
      ['insert_phrase', 'phrase_unrecognized'].sort()
    )
    const insert = tools.find((tool) => tool.function.name === PHRASE_INSERT_TOOL_NAME)!
    expect('strict' in insert.function).toBe(false)
    const schema = insert.function.parameters as {
      properties: Record<string, unknown>
      additionalProperties: boolean
      required: string[]
    }
    expect(schema.properties).not.toHaveProperty('sql')
    expect(schema.properties).not.toHaveProperty('executionId')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['phrase', 'explantation', 'example'])
  })
  it('validates tool arguments into insert content and rejects replacements', () => {
    const validated = validatePhraseInsertArguments(insertArguments(), 'look forward to')
    expect(validated).toEqual({
      phrase: 'look forward to',
      explantation: '期待，盼望（某件将发生的事）。',
      example: 'I look forward to hearing from you.'
    })
    // 短语替换：模型不得改写输入或换成其他短语。
    expect(() =>
      validatePhraseInsertArguments(
        insertArguments({ phrase: 'look forwards to' }),
        'look forward to'
      )
    ).toThrow('INVALID_ANALYSIS')
    expect(() =>
      validatePhraseInsertArguments(insertArguments({ phrase: 'break even' }), 'look forward to')
    ).toThrow('INVALID_ANALYSIS')
  })
  it.each([
    insertArguments({ sql: 'DELETE FROM phrase' }),
    insertArguments({ table: 'phrase' }),
    insertArguments({ where: '1 = 1' }),
    insertArguments({ executionId: 'model-uuid' }),
    insertArguments({ extra: true }),
    insertArguments({ phrase: '' }),
    insertArguments({ phrase: 'x'.repeat(201) }),
    insertArguments({ explantation: '' }),
    insertArguments({ explantation: '   ' }),
    insertArguments({ explantation: 'x'.repeat(2001) }),
    insertArguments({ example: '' }),
    insertArguments({ example: 'x'.repeat(1001) })
  ])('rejects illegal or oversized arguments %#', (value) => {
    expect(() => validatePhraseInsertArguments(value, 'look forward to')).toThrow(PhraseError)
  })
  it('trims generated content but keeps the phrase exactly as sent', () => {
    const validated = validatePhraseInsertArguments(
      insertArguments({ explantation: '  期待。  ', example: '  I look forward to it.  ' }),
      'look forward to'
    )
    expect(validated.explantation).toBe('期待。')
    expect(validated.example).toBe('I look forward to it.')
    // phrase 不做 trim 改写：必须与本地规范化文本严格相等。
    expect(validated.phrase).toBe('look forward to')
  })
  it('accepts only the unrecognized reason enum', () => {
    expect(
      phraseUnrecognizedToolArgumentsSchema.safeParse({ reason: 'UNRECOGNIZED' }).success
    ).toBe(true)
    for (const value of [
      { reason: 'NOT_ENGLISH' },
      { reason: 'UNRECOGNIZED', note: 'text' },
      {},
      { reason: 'UNRECOGNIZED', sql: 'DELETE FROM phrase' }
    ]) {
      expect(phraseUnrecognizedToolArgumentsSchema.safeParse(value).success).toBe(false)
    }
  })
  it('re-validates content at the database boundary', () => {
    expect(() => assertValidPhraseInsertContent(insertArguments() as never)).not.toThrow()
    expect(() =>
      assertValidPhraseInsertContent({ ...insertArguments(), phrase: 'x'.repeat(201) } as never)
    ).toThrow('Invalid phrase insert bindings')
    expect(() =>
      assertValidPhraseInsertContent({ ...insertArguments(), example: '' } as never)
    ).toThrow('Invalid phrase insert bindings')
  })
})
