import type { ExploreVocabularyCandidate } from '../../src/core/learning/explore-vocabulary/explore-vocabulary-generator'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { ExploreVocabularyHostSession } from '../../src/core/learning/explore-vocabulary/explore-vocabulary-host'
import type { ExploreVocabularyGenerateInput } from '../../src/core/learning/explore-vocabulary/explore-vocabulary-generator'

const python = resolve(
  'agent-engine/.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
)
const languages = {
  outputLanguage: 'en',
  targetLanguage: 'en',
  signal: new AbortController().signal
}
const candidates = (count: number): ExploreVocabularyCandidate[] =>
  Array.from({ length: count }, (_, i) => ({
    term: `commonword${String.fromCharCode(97 + i)}`,
    explanation: 'A useful expression.',
    example: `We use commonword${String.fromCharCode(97 + i)} here.`
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
  'partial-result',
  'phrase-operation',
  'phrase-completion'
])('rejects %s over the real exploration pipe', async (mode) => {
  const child = new PythonAgentProcess({
    command: python,
    args: [
      '-I',
      resolve('tests/integration/fixtures/agent/explore-vocabulary-fault-engine.py'),
      mode
    ]
  })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('forbidden')
  })
  const signals: AbortSignal[] = []
  const generate = vi.fn(async ({ signal }: ExploreVocabularyGenerateInput) => {
    signals.push(signal)
    if (mode === 'excess-concurrency') return new Promise<ReturnType<typeof candidates>>(() => {})
    return candidates(4)
  })
  const host = new ExploreVocabularyHostSession(
    { schemaVersion: 1, batches: [] },
    () => ({ generate }),
    'en',
    'en'
  )
  try {
    await expect(runtime.runExploreVocabulary(languages, host)).rejects.toMatchObject({
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
  const generate = vi.fn(async (input: ExploreVocabularyGenerateInput) => {
    if (input.count === 10) return candidates(4)
    return new Promise<ReturnType<typeof candidates>>(() => {})
  })
  const host = new ExploreVocabularyHostSession(
    { schemaVersion: 1, batches: [] },
    () => ({ generate }),
    'en',
    'en'
  )
  try {
    const pending = runtime.runExploreVocabulary(languages, host)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2))
    process.kill(child.pid!, 'SIGKILL')
    await rejected
    expect(() => host.completedItems()).toThrow()
    expect(generate.mock.calls.every(([input]) => input.signal.aborted)).toBe(true)
    const nextGenerate = vi.fn(async () => candidates(10))
    const next = new ExploreVocabularyHostSession(
      { schemaVersion: 1, batches: [] },
      () => ({ generate: nextGenerate }),
      'en',
      'en'
    )
    await runtime.runExploreVocabulary(languages, next)
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
      term: `privatehistory${item.term}`,
      normalizedTerm: `privatehistory${item.term}`,
      example: `We use privatehistory${item.term} here.`
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
    const host = new ExploreVocabularyHostSession(history, () => ({ generate }), 'en', locale)
    try {
      await runtime.runExploreVocabulary({ ...languages, outputLanguage: locale }, host)
      expect(host.completedItems()).toHaveLength(10)
      expect(generate.mock.calls[0]).toBeDefined()
      const wire = JSON.stringify(sent.mock.calls)
      for (const privateValue of [
        'privatehistory',
        'commonword',
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
