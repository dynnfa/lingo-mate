import type { ExplorePhraseCandidate } from '../../src/core/learning/explore-phrase/explore-phrase-generator'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { ExplorePhraseHostSession } from '../../src/core/learning/explore-phrase/explore-phrase-host'
import type { ExplorePhraseGenerateInput } from '../../src/core/learning/explore-phrase/explore-phrase-generator'

const python = resolve(
  'agent-engine/.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
)
const languages = {
  outputLanguage: 'en',
  targetLanguage: 'en',
  signal: new AbortController().signal
}
const candidates = (count: number): ExplorePhraseCandidate[] =>
  Array.from({ length: count }, (_, i) => ({
    phrase: `common phrase ${i}`,
    explanation: 'A useful expression.',
    example: `We use common phrase ${i} here.`
  }))

it.each([
  'cross-run',
  'cross-call',
  'before-prepare',
  'premature-result',
  'forbidden-operation',
  'wrong-result',
  'duplicate-prepare',
  'skipped-attempt',
  'excess-concurrency',
  'duplicate-attempt',
  'forged-count',
  'partial-result'
])('rejects %s over the real exploration pipe', async (mode) => {
  const child = new PythonAgentProcess({
    command: python,
    args: ['-I', resolve('tests/integration/fixtures/agent/explore-phrase-fault-engine.py'), mode]
  })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('forbidden')
  })
  const signals: AbortSignal[] = []
  const generate = vi.fn(async ({ signal }: ExplorePhraseGenerateInput) => {
    signals.push(signal)
    if (mode === 'excess-concurrency') return new Promise<ReturnType<typeof candidates>>(() => {})
    return candidates(4)
  })
  const host = new ExplorePhraseHostSession(
    { schemaVersion: 1, batches: [] },
    () => ({ generate }),
    'en',
    'en'
  )
  try {
    await expect(runtime.runExplorePhrase(languages, host)).rejects.toMatchObject({
      code: expect.stringMatching(/^AGENT_(PROTOCOL_ERROR|LIMIT)$/)
    })
    expect(() => host.completedItems()).toThrow()
    expect(generate.mock.calls.length).toBeLessThanOrEqual(1)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

it('discards staged exploration on engine failure and runs only an explicit new request', async () => {
  const child = new PythonAgentProcess({ command: python, args: ['-I', '-m', 'lingo_agent'] })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('forbidden')
  })
  const generate = vi.fn(async (input: ExplorePhraseGenerateInput) => {
    if (input.count === 10) return candidates(4)
    return new Promise<ReturnType<typeof candidates>>(() => {})
  })
  const host = new ExplorePhraseHostSession(
    { schemaVersion: 1, batches: [] },
    () => ({ generate }),
    'en',
    'en'
  )
  try {
    const pending = runtime.runExplorePhrase(languages, host)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2))
    process.kill(child.pid!, 'SIGKILL')
    await rejected
    expect(() => host.completedItems()).toThrow()
    expect(generate.mock.calls.every(([input]) => input.signal.aborted)).toBe(true)
    const nextGenerate = vi.fn(async () => candidates(10))
    const next = new ExplorePhraseHostSession(
      { schemaVersion: 1, batches: [] },
      () => ({ generate: nextGenerate }),
      'en',
      'en'
    )
    await runtime.runExplorePhrase(languages, next)
    expect(next.completedItems()).toHaveLength(10)
    expect(nextGenerate).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledTimes(2)
  } finally {
    await runtime.dispose()
  }
})

it.each(['zh-CN', 'en'] as const)(
  'keeps history and candidate content out of the %s Python pipe',
  async (locale) => {
    const child = new PythonAgentProcess({ command: python, args: ['-I', '-m', 'lingo_agent'] })
    const runtime = new PythonAgentRuntime(child, () => {
      throw new Error('forbidden')
    })
    const sent = vi.spyOn(child, 'send')
    const historyItems = candidates(10).map((item) => ({
      ...item,
      phrase: `private history ${item.phrase}`,
      normalizedPhrase: `private history ${item.phrase}`,
      example: `We use private history ${item.phrase} here.`
    }))
    const history = {
      schemaVersion: 1 as const,
      batches: [
        {
          executionId: '550e8400-e29b-41d4-a716-446655440000',
          sessionId: '550e8400-e29b-41d4-a716-446655440001',
          userMessageId: '550e8400-e29b-41d4-a716-446655440002',
          committedAt: '2026-10-22T00:00:00.000Z',
          wordLanguage: 'en' as const,
          explanationLanguage: 'en' as const,
          items: historyItems
        }
      ]
    }
    const generate = vi.fn(async () => candidates(10))
    const host = new ExplorePhraseHostSession(history, () => ({ generate }), 'en', locale)
    try {
      await runtime.runExplorePhrase({ ...languages, outputLanguage: locale }, host)
      expect(host.completedItems()).toHaveLength(10)
      expect(generate.mock.calls[0]).toBeDefined()
      const wire = JSON.stringify(sent.mock.calls)
      for (const privateValue of [
        'private history',
        'common phrase',
        history.batches[0].sessionId,
        history.batches[0].userMessageId,
        history.batches[0].executionId,
        'A useful expression.'
      ]) {
        expect(wire).not.toContain(privateValue)
      }
    } finally {
      await runtime.dispose()
    }
  }
)
