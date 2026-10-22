import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmExplorePhraseGenerator } from '../llm-explore-phrase-generator'
import type { CreateLlmClient, LlmClient } from '../llm-client'
import type { RuntimeModelConfig } from '../model-config'
const systemPrompt = 'Explain in Simplified Chinese (zh-CN); phrases and examples in English.'
import type { ExplorePhraseCandidate } from '../../learning/explore-phrase/explore-phrase-generator'

// 通过工厂注入 stub 客户端：适配器测试只验证请求参数与协议校验语义，
// 不经过真实 SDK；通信与记账由 llm-client 测试覆盖。
const complete = vi.fn()
const stubClient = { complete } as unknown as LlmClient
const createClient: CreateLlmClient = () => stubClient
const config: RuntimeModelConfig = {
  configured: true,
  protocol: 'openai-compatible',
  baseUrl: 'http://localhost:1234/v1',
  modelId: 'fixture',
  apiKey: undefined
}
const signal = new AbortController().signal

const candidate = (phrase: string): ExplorePhraseCandidate => ({
  phrase,
  explanation: `关于 ${phrase} 的释义`,
  example: `A sentence that uses ${phrase} naturally.`
})

const functionCall = (name: string, args: unknown): Record<string, unknown> => ({
  id: 'call_1',
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
})

const completionWith = (
  calls: Array<Record<string, unknown>> | null,
  overrides: { finishReason?: string; content?: string | null } = {}
): Record<string, unknown> => ({
  choices: [
    {
      index: 0,
      finish_reason: overrides.finishReason ?? 'tool_calls',
      message: {
        role: 'assistant',
        content: overrides.content === undefined ? null : overrides.content,
        refusal: null,
        ...(calls ? { tool_calls: calls } : {})
      }
    }
  ]
})

const submitCompletion = (items: unknown[]): Record<string, unknown> =>
  completionWith([functionCall('submit_explored_phrases', { items })])

const makeGenerator = (): LlmExplorePhraseGenerator =>
  new LlmExplorePhraseGenerator(config, 30_000, createClient)

afterEach(() => {
  vi.clearAllMocks()
})

describe('LlmExplorePhraseGenerator', () => {
  it('sends the structured request and returns validated candidates', async () => {
    const items = Array.from({ length: 10 }, (_unused, index) => candidate(`gen ${index}`))
    complete.mockResolvedValue(submitCompletion(items))

    const result = await makeGenerator().generate({
      systemPrompt,
      count: 10,
      wordLanguage: 'en',
      explanationLanguage: 'zh-CN',
      excludedPhrases: ['as a result', 'on the other hand'],
      signal
    })

    expect(result).toHaveLength(10)
    expect(result[0]).toEqual(candidate('gen 0'))
    const request = complete.mock.calls[0][0]
    expect(request.messages[0]).toMatchObject({ role: 'system' })
    expect(request.messages[0].content).toBe(systemPrompt)
    expect(JSON.parse(request.messages[1].content)).toEqual({
      count: 10,
      wordLanguage: 'en',
      explanationLanguage: 'zh-CN',
      excludedPhrases: ['as a result', 'on the other hand']
    })
    expect(request.tools).toHaveLength(1)
    expect(request.tools[0].function.name).toBe('submit_explored_phrases')
    expect(request.model).toBe('fixture')
    // 用量沿用合法 operation：phrase_analysis。
    expect(complete.mock.calls[0][1]).toMatchObject({ operation: 'phrase_analysis' })
  })

  it('rejects more items than requested as a protocol error', async () => {
    const items = Array.from({ length: 4 }, (_unused, index) => candidate(`over ${index}`))
    complete.mockResolvedValue(submitCompletion(items))
    await expect(
      makeGenerator().generate({
        systemPrompt,
        count: 3,
        wordLanguage: 'en',
        explanationLanguage: 'en',
        excludedPhrases: [],
        signal
      })
    ).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
  })

  it.each([
    ['an unknown tool', submitCompletion([]) && completionWith([functionCall('other_tool', {})])],
    ['no tool call', completionWith(null)]
  ])('rejects %s', async (_name, response) => {
    complete.mockResolvedValue(response)
    await expect(
      makeGenerator().generate({
        systemPrompt,
        count: 10,
        wordLanguage: 'en',
        explanationLanguage: 'en',
        excludedPhrases: [],
        signal
      })
    ).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
  })

  it.each([
    ['extra fields on items', submitCompletion([{ ...candidate('a'), extra: true }])],
    ['empty items array', submitCompletion([])],
    ['multiline fields', submitCompletion([{ ...candidate('a'), example: 'line\nbreak' }])],
    ['missing fields', submitCompletion([{ phrase: 'a' }])]
  ])('rejects %s', async (_name, response) => {
    complete.mockResolvedValue(response)
    await expect(
      makeGenerator().generate({
        systemPrompt,
        count: 10,
        wordLanguage: 'en',
        explanationLanguage: 'en',
        excludedPhrases: [],
        signal
      })
    ).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
  })

  it('maps malformed responses and capability failures to distinct codes', async () => {
    complete.mockResolvedValueOnce({ choices: [{ message: null }] })
    await expect(
      makeGenerator().generate({
        systemPrompt,
        count: 10,
        wordLanguage: 'en',
        explanationLanguage: 'en',
        excludedPhrases: [],
        signal
      })
    ).rejects.toMatchObject({ code: 'MODEL_ERROR' })

    complete.mockRejectedValueOnce(
      Object.assign(new Error('tools are not supported'), { status: 400 })
    )
    await expect(
      makeGenerator().generate({
        systemPrompt,
        count: 10,
        wordLanguage: 'en',
        explanationLanguage: 'en',
        excludedPhrases: [],
        signal
      })
    ).rejects.toMatchObject({ code: 'TOOL_CALL_NOT_SUPPORTED' })

    const unconfigured = new LlmExplorePhraseGenerator(
      { ...config, configured: false },
      30_000,
      createClient
    )
    await expect(
      unconfigured.generate({
        systemPrompt,
        count: 10,
        wordLanguage: 'en',
        explanationLanguage: 'en',
        excludedPhrases: [],
        signal
      })
    ).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
  })
})
