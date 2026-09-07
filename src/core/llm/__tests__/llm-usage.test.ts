import { describe, expect, it } from 'vitest'
import { MISSING_LLM_USAGE, parseLlmUsage } from '../llm-usage'

describe('parseLlmUsage', () => {
  it('treats absent usage as entirely missing', () => {
    for (const raw of [undefined, null, 42, 'usage', {}, { prompt_tokens: null }]) {
      expect(parseLlmUsage(raw)).toEqual(MISSING_LLM_USAGE)
    }
  })

  it('keeps a fully consistent report as reported', () => {
    expect(parseLlmUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })).toEqual(
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        usageStatus: 'reported'
      }
    )
  })

  it('distinguishes an explicit zero from an unknown value', () => {
    expect(parseLlmUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usageStatus: 'reported'
    })
    expect(parseLlmUsage({ prompt_tokens: 0, completion_tokens: 5 })).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      totalTokens: 5,
      usageStatus: 'derived'
    })
  })

  it('derives the total only when input and output are valid and total is missing', () => {
    expect(parseLlmUsage({ prompt_tokens: 7, completion_tokens: 3 })).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      usageStatus: 'derived'
    })
    // total 存在但非法：不做派生，也不保存非法值。
    expect(parseLlmUsage({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 'x' })).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: null,
      usageStatus: 'invalid'
    })
  })

  it('keeps partial fields with a partial status', () => {
    expect(parseLlmUsage({ prompt_tokens: 10 })).toEqual({
      inputTokens: 10,
      outputTokens: null,
      totalTokens: null,
      usageStatus: 'partial'
    })
    expect(parseLlmUsage({ total_tokens: 30 })).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: 30,
      usageStatus: 'partial'
    })
  })

  it('marks an inconsistent provider total as invalid without correcting it', () => {
    expect(parseLlmUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 999 })).toEqual(
      {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 999,
        usageStatus: 'invalid'
      }
    )
  })

  it('marks illegal numbers as invalid while keeping locally valid fields', () => {
    expect(parseLlmUsage({ prompt_tokens: -5, completion_tokens: 20, total_tokens: 15 })).toEqual({
      inputTokens: null,
      outputTokens: 20,
      totalTokens: 15,
      usageStatus: 'invalid'
    })
    expect(parseLlmUsage({ prompt_tokens: 1.5, completion_tokens: 2, total_tokens: 3 })).toEqual({
      inputTokens: null,
      outputTokens: 2,
      totalTokens: 3,
      usageStatus: 'invalid'
    })
    expect(parseLlmUsage({ prompt_tokens: '100', completion_tokens: NaN })).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      usageStatus: 'invalid'
    })
    expect(parseLlmUsage({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 })).toEqual(
      {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 1,
        totalTokens: null,
        usageStatus: 'invalid'
      }
    )
  })

  it('never throws on unexpected shapes', () => {
    expect(() => parseLlmUsage(new Date())).not.toThrow()
    expect(() => parseLlmUsage({ prompt_tokens: Symbol('x') })).not.toThrow()
  })
})
