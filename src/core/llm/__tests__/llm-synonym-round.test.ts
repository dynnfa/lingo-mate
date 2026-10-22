import { expect, it, vi } from 'vitest'
import { LlmSynonymAnalyzer } from '../llm-synonym-analyzer'

it('performs exactly one bound model round with caller-owned prompt and transcript', async () => {
  const message = {
    content: null,
    reasoning_content: 'private',
    tool_calls: [
      {
        id: 'call',
        type: 'function',
        function: { name: 'report_unrecognized_word', arguments: '{"word":"x"}' }
      }
    ]
  }
  const complete = vi
    .fn()
    .mockResolvedValue({ choices: [{ finish_reason: 'tool_calls', message }] })
  const createClient = vi.fn(() => ({ complete, stream: vi.fn() }))
  const adapter = new LlmSynonymAnalyzer(
    {
      configured: true,
      protocol: 'openai-compatible',
      baseUrl: 'http://localhost/v1',
      modelId: 'test',
      apiKey: undefined
    },
    60000,
    createClient
  )
  const result = await adapter.analyze({
    messages: [{ role: 'system', content: 'Explain in English' }],
    signal: new AbortController().signal
  })
  expect(result).toEqual({ message, canCorrectParallel: false })
  expect(complete).toHaveBeenCalledOnce()
  expect(complete.mock.calls[0][0].messages[0].content).toBe('Explain in English')
  expect(complete.mock.calls[0][1].operation).toBe('synonym_analysis')
  await adapter.analyze({
    messages: [{ role: 'system', content: 'Explain in English' }],
    signal: new AbortController().signal
  })
  expect(createClient).toHaveBeenCalledOnce()
})
