import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { SynonymHost } from '../../src/core/learning/synonym/synonym-host'
import { synonymFixture, synonymDecision } from './fixtures/synonym-host'

function processFor(mode?: string): PythonAgentProcess {
  return new PythonAgentProcess({
    command: resolve(
      'agent-engine/.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    ),
    args: mode
      ? ['-I', resolve('tests/integration/fixtures/agent/synonym-fault-engine.py'), mode]
      : ['-I', '-m', 'lingo_agent']
  })
}
const languages = {
  outputLanguage: 'en',
  targetLanguage: 'en',
  signal: new AbortController().signal
}

it.each([
  'cross-run',
  'cross-call',
  'premature-result',
  'forbidden-operation',
  'vocabulary-operation',
  'wrong-result',
  'invalid-index',
  'duplicate-index',
  'excess-concurrency',
  'apply-without-model',
  'finish-without-model',
  'wrong-round',
  'out-of-order'
])('rejects %s without authorizing a synonym write', async (mode) => {
  const child = processFor(mode)
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('forbidden')
  })
  const fixture = synonymFixture()
  try {
    await expect(runtime.runSynonym(languages, fixture.host)).rejects.toMatchObject({
      code: 'AGENT_PROTOCOL_ERROR'
    })
    expect(fixture.entries).toEqual([])
    expect(fixture.reports.every((r) => r.finalized === false)).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

it('processes 20 words sequentially with one model snapshot and no private payload crossing JSONL', async () => {
  const child = processFor()
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('forbidden')
  })
  const fixture = synonymFixture(Array.from({ length: 20 }, (_, i) => `word${i}`).join(','))
  const sent: unknown[] = []
  const send = child.send.bind(child)
  vi.spyOn(child, 'send').mockImplementation(async (...args) => {
    sent.push(structuredClone(args[0]))
    await send(...args)
  })
  try {
    await runtime.runSynonym(languages, fixture.host)
    expect(fixture.entries).toHaveLength(20)
    expect(fixture.groups).toHaveLength(1)
    expect(fixture.createAnalyzer).toHaveBeenCalledOnce()
    const wire = JSON.stringify(sent)
    for (const secret of [
      'private-gloss',
      'private-distinction',
      'private-group-meaning',
      'private-provider-thought',
      fixture.input.sessionId,
      fixture.input.executionId,
      fixture.input.userMessageId,
      fixture.entries[0].groupid
    ])
      expect(wire).not.toContain(secret)
  } finally {
    await runtime.dispose()
  }
})

it('retains committed words on engine crash and resumes only after an explicit new run', async () => {
  const child = processFor()
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('forbidden')
  })
  const fixture = synonymFixture()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const signals: AbortSignal[] = []
  const analyze = vi.fn(async (input: Parameters<typeof synonymDecision>[0]) => {
    signals.push(input.signal)
    if (JSON.parse(String(input.messages[1].content)).word === 'decent') {
      entered()
      return new Promise<Awaited<ReturnType<typeof synonymDecision>>>(() => {})
    }
    return synonymDecision(input)
  })
  const host = new SynonymHost(fixture.repository, () => ({ analyze }), fixture.input)
  try {
    const pending = runtime.runSynonym(languages, host)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    await started
    process.kill(child.pid!, 'SIGKILL')
    await rejected
    expect(fixture.entries.map((e) => e.word)).toEqual(['adequate'])
    expect(signals.at(-1)?.aborted).toBe(true)
    expect(fixture.reports.at(-1)?.finalized).toBe(false)
    const retryAnalyze = vi.fn(synonymDecision)
    const retry = new SynonymHost(fixture.repository, () => ({ analyze: retryAnalyze }), {
      ...fixture.input,
      previousReport: fixture.reports.at(-1)
    })
    await runtime.runSynonym(languages, retry)
    expect(fixture.entries.map((e) => e.word)).toEqual(['adequate', 'decent'])
    expect(retry.report(true).items.map((i) => i.status)).toEqual(['saved', 'saved'])
    expect(retryAnalyze).toHaveBeenCalledTimes(2)
    expect(child.handshakes).toBe(2)
  } finally {
    await runtime.dispose()
  }
})

it('enforces the 180-second run deadline and aborts pending transport while retaining prior commits', async () => {
  const child = processFor()
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('forbidden')
  })
  const fixture = synonymFixture()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let activeSignal: AbortSignal | undefined
  const analyze: typeof synonymDecision = async (input) => {
    if (JSON.parse(String(input.messages[1].content)).word === 'decent') {
      activeSignal = input.signal
      entered()
      return new Promise<Awaited<ReturnType<typeof synonymDecision>>>(() => {})
    }
    return synonymDecision(input)
  }
  try {
    await child.start()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const host = new SynonymHost(fixture.repository, () => ({ analyze }), fixture.input, 240_000)
    const pending = runtime.runSynonym(languages, host)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'AGENT_LIMIT' })
    await started
    await vi.advanceTimersByTimeAsync(180_000)
    await rejected
    expect(activeSignal?.aborted).toBe(true)
    expect(fixture.entries.map((e) => e.word)).toEqual(['adequate'])
    expect(fixture.reports.at(-1)?.finalized).toBe(false)
  } finally {
    vi.useRealTimers()
    await runtime.dispose()
  }
})
