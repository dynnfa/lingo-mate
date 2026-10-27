import { describe, expect, it, vi } from 'vitest'
import { LlmSentencePracticeReviewer } from '../llm-sentence-practice-reviewer'
import { ModelRequestError, type CreateLlmClient } from '../../../llm/llm-client'
import type { RuntimeModelConfig } from '../../../llm/model-config'

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

const ENTRIES = UUIDS.map((entryId, index) => ({ entryId, term: `word-${index}` }))
const HINTS = [
  { entryIds: [UUIDS[0]], phrase: 'eat an apple', explanation: '吃一个苹果' },
  { entryIds: [UUIDS[1]], phrase: 'a bunch of bananas', explanation: '一串香蕉' },
  { entryIds: [UUIDS[2]], phrase: 'ripe cherries', explanation: '成熟的樱桃' }
]
const ANSWER = 'I ate an apple and a bunch of ripe cherries.'

const REVIEW_PAYLOAD = {
  wordUsage: [
    { entryId: UUIDS[0], used: true, correct: true, feedback: '使用正确。' },
    { entryId: UUIDS[1], used: false, correct: false, feedback: '未出现 banana。' },
    { entryId: UUIDS[2], used: true, correct: true, feedback: '使用正确。' }
  ],
  fluency: { natural: true, feedback: '整体通顺。' },
  grammar: { correct: true, issues: [] },
  summary: '整体不错，但漏用了 banana。',
  revisedAnswer: 'I ate an apple, a bunch of bananas and ripe cherries.'
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
  const reviewer = new LlmSentencePracticeReviewer(config, 1000, () => client)
  return {
    complete,
    run: () =>
      reviewer.review({
        systemPrompt: 'Python-owned prompt. Explain in English.',
        entries: ENTRIES,
        hints: HINTS,
        answer: ANSWER,
        explanationLanguage: 'zh-CN',
        practiceLanguage: 'en',
        signal: new AbortController().signal
      })
  }
}

describe('llm sentence practice reviewer', () => {
  it('returns the validated review and forwards the Python system prompt', async () => {
    const { run, complete } = setup(finalResponse(JSON.stringify(REVIEW_PAYLOAD)))
    const review = await run()
    expect(review).toEqual(REVIEW_PAYLOAD)
    const [params, context] = complete.mock.calls[0]
    expect(params.messages[0].content).toBe('Python-owned prompt. Explain in English.')
    // 用户消息携带词条、提示与答案
    expect(JSON.parse(params.messages[1].content)).toEqual({
      entries: ENTRIES,
      hints: HINTS,
      answer: ANSWER
    })
    expect(context.operation).toBe('vocabulary_analysis')
    expect(params.tools).toBeUndefined()
  })

  it('fails before any request when the model is not configured', async () => {
    const complete = vi.fn()
    const client = { complete, stream: vi.fn() } satisfies ReturnType<CreateLlmClient>
    const reviewer = new LlmSentencePracticeReviewer({ configured: false }, 1000, () => client)
    await expect(
      reviewer.review({
        systemPrompt: 'Python-owned prompt. Explain in English.',
        entries: ENTRIES,
        hints: HINTS,
        answer: ANSWER,
        explanationLanguage: 'zh-CN',
        practiceLanguage: 'en',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON, empty output, refusals and truncated responses', async () => {
    const invalidResponses = [
      finalResponse('nope'),
      finalResponse(''),
      { choices: [{ finish_reason: 'stop', message: { refusal: 'no' } }] },
      { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
      { choices: [] }
    ]
    for (const response of invalidResponses) {
      const { run } = setup(response)
      await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    }
  })

  it('rejects reviews with forged, duplicated or missing word usage ids', async () => {
    const invalidPayloads = [
      // 未知 ID
      {
        ...REVIEW_PAYLOAD,
        wordUsage: REVIEW_PAYLOAD.wordUsage.map((usage, index) =>
          index === 0 ? { ...usage, entryId: '99999999-9999-4999-8999-999999999999' } : usage
        )
      },
      // 重复 ID
      {
        ...REVIEW_PAYLOAD,
        wordUsage: [
          REVIEW_PAYLOAD.wordUsage[0],
          REVIEW_PAYLOAD.wordUsage[0],
          REVIEW_PAYLOAD.wordUsage[1]
        ]
      },
      // 缺少一个词条的判定
      { ...REVIEW_PAYLOAD, wordUsage: REVIEW_PAYLOAD.wordUsage.slice(0, 2) }
    ]
    for (const payload of invalidPayloads) {
      const { run } = setup(finalResponse(JSON.stringify(payload)))
      await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    }
  })

  it('rejects self-contradictory verdicts', async () => {
    const contradictions = [
      // 未使用却判正确
      {
        ...REVIEW_PAYLOAD,
        wordUsage: REVIEW_PAYLOAD.wordUsage.map((usage, index) =>
          index === 1 ? { ...usage, used: false, correct: true } : usage
        )
      },
      // 语法正确却携带问题
      {
        ...REVIEW_PAYLOAD,
        grammar: {
          correct: true,
          issues: [{ original: 'a apple', suggestion: 'an apple', explanation: '冠词' }]
        }
      },
      // 语法错误却没有问题
      { ...REVIEW_PAYLOAD, grammar: { correct: false, issues: [] } },
      // 摘要为空
      { ...REVIEW_PAYLOAD, summary: '' }
    ]
    for (const payload of contradictions) {
      const { run } = setup(finalResponse(JSON.stringify(payload)))
      await expect(run()).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    }
  })

  it('maps network failures and timeouts to safe domain errors', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('connection reset'))
    const client = { complete, stream: vi.fn() } satisfies ReturnType<CreateLlmClient>
    const reviewer = new LlmSentencePracticeReviewer(config, 1000, () => client)
    await expect(
      reviewer.review({
        systemPrompt: 'Python-owned prompt. Explain in English.',
        entries: ENTRIES,
        hints: HINTS,
        answer: ANSWER,
        explanationLanguage: 'zh-CN',
        practiceLanguage: 'en',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'MODEL_ERROR' })

    const timeoutClient = {
      complete: vi.fn().mockRejectedValue(new ModelRequestError('NETWORK', new Error('n'))),
      stream: vi.fn()
    } satisfies ReturnType<CreateLlmClient>
    const timeoutReviewer = new LlmSentencePracticeReviewer(config, 1000, () => timeoutClient)
    await expect(
      timeoutReviewer.review({
        systemPrompt: 'Python-owned prompt. Explain in English.',
        entries: ENTRIES,
        hints: HINTS,
        answer: ANSWER,
        explanationLanguage: 'zh-CN',
        practiceLanguage: 'en',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'MODEL_ERROR' })
  })
})
