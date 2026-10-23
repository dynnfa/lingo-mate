import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import {
  AgentSentencePracticeHintGenerator,
  AgentSentencePracticeReviewer
} from '../../src/core/learning/sentence-practice/sentence-practice-agent'
import { LlmSentencePracticeHintGenerator } from '../../src/core/llm/llm-sentence-practice-hint-generator'
import { LlmSentencePracticeReviewer } from '../../src/core/llm/llm-sentence-practice-reviewer'

const python = resolve(
  'agent-engine/.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
)
const entries = [1, 2, 3].map((i) => ({
  entryId: `${i}1111111-1111-4111-8111-111111111111`,
  term: `privateword${i}`,
  referenceMeaning: 'private stored gloss'
}))
const hints = entries.map((entry) => ({
  entryIds: [entry.entryId],
  phrase: entry.term,
  explanation: 'private hint'
}))
const review = {
  wordUsage: entries.map((entry) => ({
    entryId: entry.entryId,
    used: true,
    correct: true,
    feedback: 'good'
  })),
  fluency: { natural: true, feedback: 'good' },
  grammar: { correct: true, issues: [] },
  summary: 'Well done.',
  revisedAnswer: null
}
const config = {
  configured: true as const,
  protocol: 'openai-compatible' as const,
  baseUrl: 'http://localhost/v1',
  modelId: 'fake',
  apiKey: undefined
}

it.each(['zh-CN', 'en'] as const)(
  'runs hints and review through Python with %s prompts and private bound data',
  async (locale) => {
    const child = new PythonAgentProcess({ command: python, args: ['-I', '-m', 'lingo_agent'] })
    const runtime = new PythonAgentRuntime(child, () => {
      throw new Error('Unused conversation model')
    })
    const sent = vi.spyOn(child, 'send')
    const complete = vi.fn().mockImplementation(async (params) => ({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify(
              params.messages[0].content.includes('You prepare') ? { hints } : review
            )
          }
        }
      ]
    }))
    const client = { complete, stream: vi.fn() }
    const generator = new AgentSentencePracticeHintGenerator(
      runtime,
      new LlmSentencePracticeHintGenerator(config, 1000, () => client)
    )
    const reviewer = new AgentSentencePracticeReviewer(
      runtime,
      new LlmSentencePracticeReviewer(config, 1000, () => client)
    )
    const input = {
      entries,
      explanationLanguage: locale,
      practiceLanguage: 'en' as const,
      signal: new AbortController().signal
    }
    try {
      expect(await generator.generate(input)).toEqual(hints)
      expect(await reviewer.review({ ...input, hints, answer: 'private learner answer' })).toEqual(
        review
      )
      expect(complete).toHaveBeenCalledTimes(2)
      for (const [params] of complete.mock.calls) {
        expect(params.messages[0].content).toContain(
          locale === 'zh-CN' ? 'Simplified Chinese' : 'English'
        )
        expect(params.messages[0].content).toContain('English')
      }
      const wire = JSON.stringify(sent.mock.calls)
      for (const value of [
        'privateword',
        'private stored gloss',
        entries[0].entryId,
        'private hint',
        'private learner answer',
        'Well done.'
      ])
        expect(wire).not.toContain(value)
    } finally {
      await runtime.dispose()
    }
  }
)

it.each([
  'cross-run',
  'cross-call',
  'before-prepare',
  'premature-result',
  'forbidden-operation',
  'cross-task',
  'wrong-result',
  'duplicate-prepare',
  'oversized-prompt',
  'extra-authority',
  'excess-concurrency',
  'duplicate-model',
  'engine-failure'
])('rejects %s without releasing staged hints', async (mode) => {
  const child = new PythonAgentProcess({
    command: python,
    args: [
      '-I',
      resolve('tests/integration/fixtures/agent/sentence-practice-fault-engine.py'),
      mode
    ]
  })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('Unused')
  })
  const signals: AbortSignal[] = []
  const generate = vi.fn(async ({ signal }) => {
    signals.push(signal)
    if (mode === 'excess-concurrency') return new Promise<typeof hints>(() => {})
    return hints
  })
  const generator = new AgentSentencePracticeHintGenerator(runtime, { generate })
  try {
    await expect(
      generator.generate({
        entries,
        explanationLanguage: 'en',
        practiceLanguage: 'en',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^AGENT_(PROTOCOL_ERROR|LIMIT|HOST_ERROR)$/)
    })
    expect(generate.mock.calls.length).toBeLessThanOrEqual(1)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

it.each(['cancel', 'crash'] as const)(
  'discards late model output after %s and allows an explicit new request',
  async (mode) => {
    const child = new PythonAgentProcess({ command: python, args: ['-I', '-m', 'lingo_agent'] })
    const runtime = new PythonAgentRuntime(child, () => {
      throw new Error('Unused')
    })
    const controller = new AbortController()
    let resolveModel!: (value: typeof hints) => void
    const generate = vi.fn(
      () =>
        new Promise<typeof hints>((resolve) => {
          resolveModel = resolve
        })
    )
    const generator = new AgentSentencePracticeHintGenerator(runtime, { generate })
    const input = {
      entries,
      explanationLanguage: 'en' as const,
      practiceLanguage: 'en' as const,
      signal: controller.signal
    }
    try {
      const pending = generator.generate(input)
      const rejected =
        mode === 'cancel'
          ? expect(pending).rejects.toMatchObject({ name: 'AbortError' })
          : expect(pending).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
      if (mode === 'cancel') controller.abort()
      else process.kill(child.pid!, 'SIGKILL')
      await rejected
      resolveModel(hints)
      const nextGenerate = vi.fn(async () => hints)
      const next = new AgentSentencePracticeHintGenerator(runtime, { generate: nextGenerate })
      expect(await next.generate({ ...input, signal: new AbortController().signal })).toEqual(hints)
      expect(nextGenerate).toHaveBeenCalledTimes(1)
      expect(generate).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.dispose()
    }
  }
)

it('refuses oversized bound input before requesting the provider', async () => {
  const child = new PythonAgentProcess({ command: python, args: ['-I', '-m', 'lingo_agent'] })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('Unused')
  })
  const generate = vi.fn(async () => hints)
  const generator = new AgentSentencePracticeHintGenerator(runtime, { generate })
  try {
    await expect(
      generator.generate({
        entries: entries.map((entry) => ({ ...entry, referenceMeaning: '😀'.repeat(12000) })),
        explanationLanguage: 'en',
        practiceLanguage: 'en',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'AGENT_LIMIT' })
    expect(generate).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
})

it('propagates invalid model analysis without retrying', async () => {
  const child = new PythonAgentProcess({ command: python, args: ['-I', '-m', 'lingo_agent'] })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('Unused')
  })
  const complete = vi.fn(async () => ({
    choices: [{ finish_reason: 'stop', message: { content: '{"hints":[]}' } }]
  }))
  const generator = new AgentSentencePracticeHintGenerator(
    runtime,
    new LlmSentencePracticeHintGenerator(config, 1000, () => ({ complete, stream: vi.fn() }))
  )
  try {
    await expect(
      generator.generate({
        entries,
        explanationLanguage: 'en',
        practiceLanguage: 'en',
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'INVALID_ANALYSIS' })
    expect(complete).toHaveBeenCalledTimes(1)
  } finally {
    await runtime.dispose()
  }
})
