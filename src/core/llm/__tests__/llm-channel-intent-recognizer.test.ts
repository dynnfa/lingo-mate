import { describe, expect, it, vi } from 'vitest'
import { LlmChannelIntentRecognizer } from '../llm-channel-intent-recognizer'
import type { CreateLlmClient, LlmClient } from '../llm-client'
import type { RuntimeModelConfig } from '../model-config'

// 通过工厂注入 stub 客户端：只验证请求参数与协议映射，不经过真实 SDK。

const create = vi.fn()
const stubClient = { complete: create } as unknown as LlmClient
const createClient: CreateLlmClient = () => stubClient
const config: RuntimeModelConfig = {
  configured: true,
  protocol: 'openai-compatible',
  baseUrl: 'http://localhost:1234/v1',
  modelId: 'fixture',
  apiKey: undefined
}

const functionCall = (name: string, args: unknown): Record<string, unknown> => ({
  id: 'call_1',
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
})

const completionWith = (calls: Array<Record<string, unknown>>): Record<string, unknown> => ({
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        refusal: null,
        tool_calls: calls
      }
    }
  ]
})

const input = {
  text: '帮我记住 apple 和 banana',
  outputLanguage: 'zh-CN' as const,
  targetLanguage: 'en' as const,
  signal: new AbortController().signal
}

describe('LlmChannelIntentRecognizer', () => {
  it('maps save intent tool calls to candidate words', async () => {
    create.mockResolvedValueOnce(
      completionWith([functionCall('recognize_save_intent', { words: ['apple', 'banana'] })])
    )
    const recognizer = new LlmChannelIntentRecognizer(config, 10_000, createClient)
    await expect(recognizer.recognize(input)).resolves.toEqual({
      status: 'save',
      words: ['apple', 'banana']
    })
    const request = create.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>
    }
    expect(request.messages[0].content).toContain('简体中文')
    expect(JSON.parse(request.messages[1].content)).toMatchObject({ targetLanguage: 'en' })
  })

  it('maps no-intent and unclear tool calls', async () => {
    create.mockResolvedValueOnce(completionWith([functionCall('report_no_save_intent', {})]))
    const recognizer = new LlmChannelIntentRecognizer(config, 10_000, createClient)
    await expect(recognizer.recognize(input)).resolves.toEqual({ status: 'none' })

    create.mockResolvedValueOnce(completionWith([functionCall('report_unclear_intent', {})]))
    await expect(recognizer.recognize(input)).resolves.toEqual({ status: 'clarify' })
  })

  it('rejects unknown tool names and malformed save arguments', async () => {
    create.mockResolvedValueOnce(completionWith([functionCall('insert_vocabulary', {})]))
    const recognizer = new LlmChannelIntentRecognizer(config, 10_000, createClient)
    await expect(recognizer.recognize(input)).rejects.toThrow(/Unexpected channel intent tool/)

    create.mockResolvedValueOnce(
      completionWith([functionCall('recognize_save_intent', { words: [] })])
    )
    await expect(recognizer.recognize(input)).rejects.toThrow()
  })

  it('refuses to run without a configured model', async () => {
    const recognizer = new LlmChannelIntentRecognizer(
      { ...config, configured: false },
      10_000,
      createClient
    )
    await expect(recognizer.recognize(input)).rejects.toThrow('MODEL_NOT_CONFIGURED')
  })
})
