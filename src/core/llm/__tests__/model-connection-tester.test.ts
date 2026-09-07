import { describe, expect, it, vi } from 'vitest'
import { ModelConnectionTester } from '../model-connection-tester'
import { ModelRequestError, type CreateLlmClient, type LlmClient } from '../llm-client'

const CONFIG = {
  configured: true as const,
  protocol: 'openai-compatible' as const,
  baseUrl: 'https://model.invalid/v1',
  modelId: 'test-model',
  apiKey: undefined
}

const completion = (content: string): Awaited<ReturnType<LlmClient['complete']>> => ({
  id: 'test',
  object: 'chat.completion',
  created: 0,
  model: 'test-model',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      logprobs: null,
      message: { role: 'assistant', content, refusal: null }
    }
  ]
})

function makeTester(complete: LlmClient['complete']): {
  tester: ModelConnectionTester
  createClient: ReturnType<typeof vi.fn<CreateLlmClient>>
} {
  const createClient = vi.fn<CreateLlmClient>(() => ({
    complete,
    stream: vi.fn<LlmClient['stream']>()
  }))
  return { tester: new ModelConnectionTester(1_000, createClient), createClient }
}

describe('ModelConnectionTester', () => {
  it('passes the draft configuration and connection context to the client', async () => {
    const complete = vi.fn<LlmClient['complete']>().mockResolvedValue(completion('ok'))
    const { tester, createClient } = makeTester(complete)
    const signal = new AbortController().signal
    expect(await tester.test(CONFIG, signal)).toEqual({ status: 'ok' })
    expect(createClient).toHaveBeenCalledWith(CONFIG)
    expect(complete).toHaveBeenCalledWith(
      { model: CONFIG.modelId, messages: [{ role: 'user', content: expect.any(String) }] },
      { operation: 'connection_test', timeoutMs: 1_000, signal }
    )
  })

  it.each([completion(''), { ...completion('ok'), choices: [] }])(
    'rejects a completion without text',
    async (response) => {
      const { tester } = makeTester(async () => response)
      expect(await tester.test(CONFIG, new AbortController().signal)).toEqual({
        status: 'error',
        error: { code: 'TEST_UNSUPPORTED_RESPONSE' }
      })
    }
  )

  it.each([
    ['PROTOCOL', 'TEST_UNSUPPORTED_RESPONSE'],
    ['TIMEOUT', 'TEST_TIMEOUT'],
    ['AUTH', 'TEST_AUTH_FAILED'],
    ['NETWORK', 'TEST_NETWORK_ERROR']
  ] as const)('maps %s client failures to %s', async (kind, code) => {
    const { tester } = makeTester(async () => {
      throw new ModelRequestError(kind, new Error('test failure'))
    })
    expect(await tester.test(CONFIG, new AbortController().signal)).toEqual({
      status: 'error',
      error: { code }
    })
  })

  it('does not create a client when cancellation preceded the test', async () => {
    const complete = vi.fn<LlmClient['complete']>()
    const { tester, createClient } = makeTester(complete)
    const controller = new AbortController()
    controller.abort()
    expect(await tester.test(CONFIG, controller.signal)).toEqual({
      status: 'error',
      error: { code: 'TEST_CANCELLED' }
    })
    expect(createClient).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })
})
