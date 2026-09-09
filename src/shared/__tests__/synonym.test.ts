import { describe, expect, it } from 'vitest'
import {
  SYNONYM_CHANNELS,
  synonymGroupPageSchema,
  synonymGroupSchema,
  synonymListInputSchema,
  synonymListResultSchema,
  synonymManagementErrorSchema
} from '../synonym'

const GROUP_ID = '11111111-1111-4111-8111-111111111111'

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    word: 'adequate',
    meaning: 'acceptable',
    groupid: GROUP_ID,
    distinction: 'minimum standard',
    ...overrides
  }
}

describe('synonym management protocol', () => {
  it('defines stable domain-named channels', () => {
    expect(SYNONYM_CHANNELS).toEqual({ list: 'synonym:list' })
  })

  it('accepts an empty input or a UUID cursor only', () => {
    expect(synonymListInputSchema.parse({})).toEqual({})
    expect(synonymListInputSchema.parse({ cursor: GROUP_ID })).toEqual({ cursor: GROUP_ID })
    for (const value of [
      { cursor: 'not-a-uuid' },
      { cursor: '' },
      { cursor: GROUP_ID, limit: 5 },
      { limit: 5 },
      { sql: 'select' }
    ]) {
      expect(synonymListInputSchema.safeParse(value).success).toBe(false)
    }
  })

  it('accepts complete groups with consistent membership', () => {
    expect(
      synonymGroupSchema.safeParse({
        id: GROUP_ID,
        meaning: 'acceptable',
        words: [entry(), entry({ id: '33333333-3333-4333-8333-333333333333' })]
      }).success
    ).toBe(true)
  })

  it('rejects groups without words or with foreign entries', () => {
    for (const overrides of [
      { words: [] },
      { words: [entry({ groupid: '44444444-4444-4444-8444-444444444444' })] },
      { meaning: '' },
      { meaning: 'x'.repeat(2001) },
      { id: 'not-a-uuid' },
      { extra: true }
    ]) {
      expect(
        synonymGroupSchema.safeParse({
          id: GROUP_ID,
          meaning: 'acceptable',
          words: [entry()],
          ...overrides
        } as Record<string, unknown>).success
      ).toBe(false)
    }
  })

  it('validates pages with an explicit nullable cursor', () => {
    const group = { id: GROUP_ID, meaning: 'acceptable', words: [entry()] }
    expect(synonymGroupPageSchema.parse({ groups: [group], nextCursor: null })).toEqual({
      groups: [group],
      nextCursor: null
    })
    expect(synonymGroupPageSchema.parse({ groups: [], nextCursor: GROUP_ID }).nextCursor).toBe(
      GROUP_ID
    )
    for (const value of [
      { groups: [] },
      { groups: [group], nextCursor: 'not-a-uuid' },
      { groups: [group], nextCursor: undefined },
      { groups: [group] }
    ]) {
      expect(synonymGroupPageSchema.safeParse(value).success).toBe(false)
    }
  })

  it('validates list results as an ok/error discriminated union', () => {
    const group = { id: GROUP_ID, meaning: 'acceptable', words: [entry()] }
    expect(
      synonymListResultSchema.parse({ status: 'ok', groups: [group], nextCursor: null })
    ).toEqual({ status: 'ok', groups: [group], nextCursor: null })
    expect(
      synonymListResultSchema.parse({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    ).toEqual({ status: 'error', error: { code: 'STORAGE_FAILED' } })
    for (const value of [
      { status: 'ok', groups: [{ ...group, words: [] }] },
      { status: 'ok', groups: [group], nextCursor: undefined },
      { status: 'ok' },
      { status: 'error', error: { code: 'MODEL_ERROR' } },
      { status: 'error', error: { code: 'STORAGE_FAILED', sql: 'select' } },
      { status: 'pending' }
    ]) {
      expect(synonymListResultSchema.safeParse(value).success).toBe(false)
    }
  })

  it('keeps management errors to safe codes only', () => {
    expect(synonymManagementErrorSchema.parse({ code: 'UNTRUSTED_SOURCE' })).toEqual({
      code: 'UNTRUSTED_SOURCE'
    })
    for (const code of ['MODEL_ERROR', 'SCAN_LIMIT', 'CANCELLED']) {
      expect(synonymManagementErrorSchema.safeParse({ code }).success).toBe(false)
    }
  })
})
