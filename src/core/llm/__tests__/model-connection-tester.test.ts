import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelConnectionTester } from '../model-connection-tester'

const CONFIG = {
  configured: true as const,
  protocol: 'openai-compatible' as const,
  baseUrl: 'https://model.invalid/v1',
  modelId: 'test-model',
  apiKey: undefined
}

afterEach(() => vi.unstubAllGlobals())

describe('ModelConnectionTester', () => {
  it.each(['null', '{}', '{broken'])('rejects an unsupported completion: %s', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            headers: { 'content-type': 'application/json' }
          })
      )
    )
    expect(await new ModelConnectionTester().test(CONFIG, new AbortController().signal)).toEqual({
      status: 'error',
      error: { code: 'TEST_UNSUPPORTED_RESPONSE' }
    })
  })

  it('does not send a request when cancellation preceded the test', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const controller = new AbortController()
    controller.abort()
    expect(await new ModelConnectionTester().test(CONFIG, controller.signal)).toEqual({
      status: 'error',
      error: { code: 'TEST_CANCELLED' }
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
