import { describe, expect, it, vi } from 'vitest'
import { LlmSentencePracticeHintGenerator } from '../llm-sentence-practice-hint-generator'
import { ModelRequestError, type CreateLlmClient } from '../llm-client'
import type { RuntimeModelConfig } from '../model-config'
import { SentencePracticeError } from '../../learning/sentence-practice/parse-sentence-practice-input'

const config: RuntimeModelConfig = {
  configured: true,
  protocol: 'openai-compatible',
  baseUrl: 'http://localhost:1234/v1',
  modelId: 'test',
  apiKey: undefined
}

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
]

const ENTRIES = [
  { entryId: UUIDS[0], term: 'apple', referenceMeaning: '一种水果' },
  { entryId: UUIDS[1], term: 'banana', referenceMeaning: null },
  { entryId: UUIDS[2], term: 'cherry', referenceMeaning: '樱桃' }
]

const HINTS_PAYLOAD = {
  hints: [
    { entryIds: [UUIDS[0]], phrase: 'eat an apple', explanation: '吃一个苹果' },
    { entryIds: [UUIDS[1]], phrase: 'a bunch of bananas', explanation: '一串香蕉' },
    { entryIds: [UUIDS[2]], phrase: 'ripe cherries', explanation: '成熟的樱桃' }
  ]
}

function finalResponse(content: string): unknown {
  return {
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }]
  }
}

function setup(response: unknown): {
  complete: ReturnType<typeof vi.fn>
  run: () => Promise<unknown>
} {
  const complete = vi.fn().mockImplementation(async () => response)
  const client = { complete, stream: vi.fn() } satisfies ReturnType<CreateLlmClient>
  const generator = new LlmSentencePracticeHintGenerator(config, 1000, () => client)
  return {
    complete,
    run: () =>
      generator.generate({
        systemPrompt: 'Python-owned prompt. Explain in English.',
        entries: ENTRIES,
        explanationLanguage: 'zh-CN',
        practiceLanguage: 'en',
        signal: new AbortController().signal
      })
  }
}

describe('llm sentence practice hint generator', () => {
  it('returns validated hints and forwards the Python system prompt', async () => {
    const { run, complete } = setup(finalResponse(JSON.stringify(HINTS_PAYLOAD)))
    const hints = await run()
    expect(hints).toEqual(HINTS_PAYLOAD.hints)
    const [params, context] = complete.mock.calls[0]
    expect(params.messages[0].content).toBe('Python-owned prompt. Explain in English.')
    // 用户消息只携带词条数据
    expect(JSON.parse(params.messages[1].content)).toEqual({ entries: ENTRIES })
    expect(context.operation).toBe('vocabulary_analysis')
    expect(params.tools).toBeUndefined()
  })

  it('fails before any request when the model is not configured', async () => {
    const complete = vi.fn()
    const client = { complete, stream: vi.fn() } satisfies ReturnType<CreateLlmClient>
    const generator = new LlmSentencePracticeHintGenerator(
      { configured: false },
      1000,
      () => client
    )
    await expect(
      generator.generate({
        systemPrompt: 'Python-owned prompt. Explain in English.',
        entries: ENTRIES,
        explanationLanguage: 'zh-CN',
        practiceLanguage: 'en',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON, empty output, refusals and truncated responses', async () => {
    const invalidResponses = [
      finalResponse('not json at all'),
      finalResponse(''),
      finalResponse('   '),
      { choices: [{ finish_reason: 'stop', message: { refusal: 'no' } }] },
      { choices: [{ finish_reason: 'length', message: { content: '{"hints":[]}' } }] },
      { choices: [] }
    ]
    for (const response of invalidResponses) {
      const { run } = setup(response)
      await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    }
  })

  it('rejects hints that break the count, id or coverage contract', async () => {
    const invalidPayloads = [
      { hints: HINTS_PAYLOAD.hints.slice(0, 2) },
      {
        hints: [
          ...HINTS_PAYLOAD.hints,
          ...HINTS_PAYLOAD.hints,
          ...HINTS_PAYLOAD.hints,
          HINTS_PAYLOAD.hints[0]
        ]
      },
      {
        hints: [
          HINTS_PAYLOAD.hints[0],
          HINTS_PAYLOAD.hints[1],
          { entryIds: ['99999999-9999-4999-8999-999999999999'], phrase: 'x', explanation: 'y' }
        ]
      },
      { hints: [HINTS_PAYLOAD.hints[0], HINTS_PAYLOAD.hints[0], HINTS_PAYLOAD.hints[1]] },
      { hints: 'not-an-array' },
      {}
    ]
    for (const payload of invalidPayloads) {
      const { run } = setup(finalResponse(JSON.stringify(payload)))
      await expect(run()).rejects.toBeInstanceOf(SentencePracticeError)
      await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    }
  })

  it('maps network failures and timeouts to safe domain errors', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('socket hang up'))
    const client = { complete, stream: vi.fn() } satisfies ReturnType<CreateLlmClient>
    const generator = new LlmSentencePracticeHintGenerator(config, 1000, () => client)
    await expect(
      generator.generate({
        systemPrompt: 'Python-owned prompt. Explain in English.',
        entries: ENTRIES,
        explanationLanguage: 'zh-CN',
        practiceLanguage: 'en',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'MODEL_ERROR' })

    const timeoutClient = {
      complete: vi.fn().mockRejectedValue(new ModelRequestError('TIMEOUT', new Error('t'))),
      stream: vi.fn()
    } satisfies ReturnType<CreateLlmClient>
    const timeoutGenerator = new LlmSentencePracticeHintGenerator(config, 1000, () => timeoutClient)
    await expect(
      timeoutGenerator.generate({
        systemPrompt: 'Python-owned prompt. Explain in English.',
        entries: ENTRIES,
        explanationLanguage: 'zh-CN',
        practiceLanguage: 'en',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})
