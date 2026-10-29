import { expect, it, vi } from 'vitest'
import { LlmSentenceTranslator } from '../llm-sentence-translator'
import { ModelRequestError } from '../../../llm/llm-client'
const config = {
  configured: true as const,
  protocol: 'openai-compatible' as const,
  baseUrl: 'http://localhost/v1',
  modelId: 'test',
  apiKey: undefined
}
const input = {
  sourceText: 'I very like it.\nKeep this line.',
  targetLanguage: 'en' as const,
  systemPrompt: 'Python-owned prompt. Translation in English.',
  signal: new AbortController().signal
}
function response(
  content: string,
  reason = 'stop',
  refusal: string | null = null
): {
  choices: Array<{ finish_reason: string; message: { content: string; refusal: string | null } }>
} {
  return { choices: [{ finish_reason: reason, message: { content, refusal } }] }
}
it('sends the bound passage with the Python prompt and returns one validated translation', async () => {
  const complete = vi
    .fn()
    .mockResolvedValue(response('{"translation":"I really like it.\\nKeep this line."}'))
  const translator = new LlmSentenceTranslator(config, () => ({ complete, stream: vi.fn() }))
  expect(await translator.translate(input)).toBe('I really like it.\nKeep this line.')
  expect(complete).toHaveBeenCalledExactlyOnceWith(
    {
      model: 'test',
      messages: [
        { role: 'system', content: input.systemPrompt },
        {
          role: 'user',
          content: JSON.stringify({ sourceText: input.sourceText, targetLanguage: 'en' })
        }
      ]
    },
    { operation: 'sentence_translation', timeoutMs: 60000, signal: input.signal }
  )
})
it.each([
  response(''),
  response('not JSON'),
  response('{"translation":""}'),
  response('{"translation":"   "}'),
  response('{"translation":4}'),
  response('{"translation":"ok","explanation":"extra"}'),
  response('{"translation":"cut"}', 'length'),
  response('{"translation":"ok"}', 'stop', 'refused'),
  response(JSON.stringify({ translation: 'a'.repeat(32769) })),
  response(JSON.stringify({ translation: '😀'.repeat(16385) })),
  {}
])(
  'rejects malformed, refused, truncated and oversized responses without retrying',
  async (raw) => {
    const complete = vi.fn().mockResolvedValue(raw)
    const translator = new LlmSentenceTranslator(config, () => ({ complete, stream: vi.fn() }))
    await expect(translator.translate(input)).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    expect(complete).toHaveBeenCalledTimes(1)
  }
)
it('preserves timeout semantics and makes no automatic retry', async () => {
  const complete = vi.fn().mockRejectedValue(new ModelRequestError('TIMEOUT', new Error('Timeout')))
  await expect(
    new LlmSentenceTranslator(config, () => ({ complete, stream: vi.fn() })).translate(input)
  ).rejects.toMatchObject({ code: 'TIMEOUT' })
  expect(complete).toHaveBeenCalledTimes(1)
})
it('cancels before requesting the model', async () => {
  const controller = new AbortController()
  controller.abort()
  const complete = vi.fn()
  await expect(
    new LlmSentenceTranslator(config, () => ({ complete, stream: vi.fn() })).translate({
      ...input,
      signal: controller.signal
    })
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(complete).not.toHaveBeenCalled()
})
