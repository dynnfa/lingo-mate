import type { VocabularyAgentRunInput } from '../../../core/agent/agent-runtime'
import { runtimeCases } from './runtime-cases'
import { expect, it, vi } from 'vitest'
import { PythonAgentRuntime } from '../python-agent-runtime'
import { ControlledProcess, tick, sentRun } from './runtime-fixture'

const input = (): VocabularyAgentRunInput => ({
  outputLanguage: 'en',
  targetLanguage: 'en',
  signal: new AbortController().signal
})

it('refuses an uninstalled test tool loop before starting Python', async () => {
  const child = new ControlledProcess()
  const runtime = new PythonAgentRuntime(child, vi.fn())
  child.onSend = (frame) => {
    if (frame.type === 'run')
      void tick().then(() =>
        child.emit({ type: 'error', runId: frame.runId, code: 'AGENT_PROTOCOL_ERROR' })
      )
  }
  try {
    const consume = async (): Promise<void> => {
      for await (const event of runtime.stream({
        ...input(),
        task: 'tool-loop',
        sessionId: '',
        messages: [{ role: 'user', content: 'word' }]
      }))
        void event
    }
    await expect(consume()).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    expect(child.start).not.toHaveBeenCalled()
    expect(child.sent).toEqual([])
  } finally {
    await runtime.dispose()
  }
})

it('rejects success while a vocabulary preparation is still pending without releasing results', async () => {
  const child = new ControlledProcess()
  const runtime = new PythonAgentRuntime(child, vi.fn())
  let release!: (value: {
    items: [{ inputIndex: number; term: string; status: 'pending' }]
  }) => void
  const prepare = vi.fn(
    () =>
      new Promise<{ items: [{ inputIndex: number; term: string; status: 'pending' }] }>(
        (resolve) => {
          release = resolve
        }
      )
  )
  const verifyCompletion = vi.fn()
  child.onSend = (frame) => {
    if (frame.type !== 'run') return
    void tick().then(() => {
      child.emit({
        type: 'host_call',
        runId: frame.runId,
        callId: `${frame.runId}:prepare`,
        operation: 'vocabulary.prepare',
        args: {}
      })
      child.emit({
        type: 'vocabulary_result',
        runId: frame.runId,
        result: { completedIndices: [] }
      })
    })
  }
  try {
    await expect(
      runtime.runVocabulary(input(), { prepare, analyze: vi.fn(), verifyCompletion })
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(verifyCompletion).not.toHaveBeenCalled()
    release({ items: [{ inputIndex: 0, term: 'word', status: 'pending' }] })
    await tick()
    expect(child.sent.filter((frame) => frame.type === 'host_result')).toEqual([])
  } finally {
    await runtime.dispose()
  }
})

it.each(runtimeCases)(
  'rejects a completion frame belonging to another task for $task',
  async (entry) => {
    const child = new ControlledProcess()
    const verify = vi.fn()
    const runtime = controlledRuntime(child)
    try {
      const outcome = entry.run(runtime, verify).catch((error: unknown) => error)
      await tick()
      const { runId } = sentRun(child)
      child.emit(
        entry.success.type === 'tts_result'
          ? { type: 'result', runId, text: '' }
          : { type: 'tts_result', runId, result: { completed: true } }
      )
      expect(await outcome).toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
      expect(verify).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  }
)

it.each(runtimeCases)(
  'accepts the correct $task completion only once and ignores retired output',
  async (entry) => {
    const child = new ControlledProcess()
    const verify = vi.fn()
    const runtime = controlledRuntime(child)
    try {
      const done = entry.run(runtime, verify)
      await tick()
      const { runId } = sentRun(child)
      const frame = { ...entry.success, runId }
      child.emit(frame)
      child.emit(frame)
      await done
      child.emit(frame)
      if (entry.success.type !== 'result')
        expect(verify).toHaveBeenCalledExactlyOnceWith(entry.success.result)
      expect(child.invalidate).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  }
)

it.each(runtimeCases.filter((entry) => entry.success.type !== 'result'))(
  'rejects stream events in the receipt-only $task task',
  async (entry) => {
    const child = new ControlledProcess()
    const verify = vi.fn()
    const runtime = controlledRuntime(child)
    try {
      const outcome = entry.run(runtime, verify).catch((error: unknown) => error)
      await tick()
      const { runId } = sentRun(child)
      child.emit({ type: 'event', runId, seq: 1, event: { type: 'text', delta: 'leak' } })
      expect(await outcome).toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
      expect(verify).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  }
)

it('keeps verification exceptions on the existing failure path', async () => {
  const child = new ControlledProcess()
  const runtime = controlledRuntime(child)
  const verify = vi.fn(() => {
    throw new Error('Domain receipt mismatch')
  })
  try {
    const entry = runtimeCases[0]
    const outcome = entry.run(runtime, verify).catch((error: unknown) => error)
    await tick()
    const { runId } = sentRun(child)
    child.emit({ ...entry.success, runId })
    child.emit({ ...entry.success, runId })
    expect(await outcome).toMatchObject({ message: 'Domain receipt mismatch' })
    expect(verify).toHaveBeenCalledOnce()
  } finally {
    await runtime.dispose()
  }
})

function controlledRuntime(child: ControlledProcess): PythonAgentRuntime {
  return new PythonAgentRuntime(child, vi.fn(), {
    decide: async () => ({ kind: 'final', text: '' }),
    lookup: async () => ({ entries: [] })
  })
}

it.each([
  ['vocabulary', 'allowed'],
  ['vocabulary', 'third'],
  ['vocabulary', 'prepare'],
  ['phrase', 'allowed'],
  ['phrase', 'third'],
  ['phrase', 'prepare']
] as const)('allows only two bound %s analyses concurrently (%s)', async (task, mode) => {
  const child = new ControlledProcess()
  const runtime = new PythonAgentRuntime(child, vi.fn())
  const releases: Array<() => void> = []
  const analyze = vi.fn(
    ({ inputIndex }: { inputIndex: number; systemPrompt: string }) =>
      new Promise<{ inputIndex: number; status: 'staged' }>((resolve) => {
        releases.push(() => resolve({ inputIndex, status: 'staged' }))
      })
  )
  const verifyCompletion = vi.fn()
  const items = [0, 1, 2].map((inputIndex) => ({ inputIndex, status: 'pending' as const }))
  const outcome = (
    task === 'vocabulary'
      ? runtime.runVocabulary(input(), {
          prepare: () => ({ items: items.map((item) => ({ ...item, term: 'word' })) }),
          analyze,
          verifyCompletion
        })
      : runtime.runPhrase(input(), {
          prepare: () => ({ items: items.map((item) => ({ ...item, phrase: 'a phrase' })) }),
          analyze,
          verifyCompletion
        })
  ).catch((error: unknown) => error)
  try {
    await tick()
    const { runId } = sentRun(child)
    child.emit({
      type: 'host_call',
      runId,
      callId: `${runId}:prepare`,
      operation: `${task}.prepare`,
      args: {}
    })
    await tick()
    const operation = task === 'vocabulary' ? 'model.vocabulary' : 'model.phrase'
    for (const inputIndex of [0, 1])
      child.emit({
        type: 'host_call',
        runId,
        callId: `${runId}:${inputIndex}`,
        operation,
        args: { inputIndex, systemPrompt: 'Explain in English.' }
      })
    await tick()
    expect(analyze).toHaveBeenCalledTimes(2)
    if (mode !== 'allowed') {
      child.emit(
        mode === 'third'
          ? {
              type: 'host_call',
              runId,
              callId: `${runId}:2`,
              operation,
              args: { inputIndex: 2, systemPrompt: 'Explain in English.' }
            }
          : {
              type: 'host_call',
              runId,
              callId: `${runId}:again`,
              operation: `${task}.prepare`,
              args: {}
            }
      )
      expect(await outcome).toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
      expect(verifyCompletion).not.toHaveBeenCalled()
    }
    releases.forEach((release) => release())
    await tick()
    child.emit({
      type: task === 'vocabulary' ? 'vocabulary_result' : 'phrase_result',
      runId,
      result: { completedIndices: [0, 1] }
    })
    if (mode === 'allowed') {
      expect(await outcome).toBeUndefined()
      expect(verifyCompletion).toHaveBeenCalledExactlyOnceWith({ completedIndices: [0, 1] })
      expect(child.sent.filter((frame) => frame.type === 'host_result')).toHaveLength(3)
    } else expect(child.sent.filter((frame) => frame.type === 'host_result')).toHaveLength(1)
    expect(analyze).toHaveBeenCalledTimes(2)
  } finally {
    await runtime.dispose()
  }
})

it.each(['parallel', 'duplicate', 'foreign-id', 'cancel', 'exit', 'premature-success'] as const)(
  'rejects or cancels a pending synthesis (%s) without replay or a late receipt',
  async (mode) => {
    const child = new ControlledProcess()
    const runtime = new PythonAgentRuntime(child, vi.fn())
    const abort = new AbortController()
    let release!: () => void
    const synthesize = vi.fn(
      () =>
        new Promise<{ completed: true }>((resolve) => {
          release = () => resolve({ completed: true })
        })
    )
    const verifyCompletion = vi.fn()
    const outcome = runtime
      .runTts({ ...input(), signal: abort.signal }, { synthesize, verifyCompletion })
      .catch((error: unknown) => error)
    try {
      await tick()
      const { runId } = sentRun(child)
      const first = {
        type: 'host_call' as const,
        runId,
        callId: `${runId}:one`,
        operation: 'tts.synthesize' as const,
        args: {}
      }
      child.emit(first)
      await tick()
      if (mode === 'cancel') abort.abort()
      else if (mode === 'exit') child.invalidate('AGENT_UNAVAILABLE')
      else if (mode === 'premature-success')
        child.emit({ type: 'tts_result', runId, result: { completed: true } })
      else
        child.emit({
          ...first,
          callId:
            mode === 'parallel'
              ? `${runId}:two`
              : mode === 'foreign-id'
                ? 'other:one'
                : first.callId
        })
      expect(await outcome).toMatchObject(
        mode === 'cancel'
          ? { name: 'AbortError' }
          : { code: mode === 'exit' ? 'AGENT_UNAVAILABLE' : 'AGENT_PROTOCOL_ERROR' }
      )
      release()
      await tick()
      child.emit({ type: 'tts_result', runId, result: { completed: true } })
      expect(synthesize).toHaveBeenCalledOnce()
      expect(verifyCompletion).not.toHaveBeenCalled()
      expect(child.sent.filter((frame) => frame.type === 'host_result')).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  }
)

it('fails a host-result send once and does not replay the synthesis', async () => {
  const child = new ControlledProcess()
  const runtime = new PythonAgentRuntime(child, vi.fn())
  const synthesize = vi.fn(async () => ({ completed: true as const }))
  const verifyCompletion = vi.fn()
  child.onSend = (frame) => {
    if (frame.type === 'host_result') throw new Error('transport closed')
  }
  const outcome = runtime
    .runTts(input(), { synthesize, verifyCompletion })
    .catch((error: unknown) => error)
  try {
    await tick()
    const { runId } = sentRun(child)
    const frame = {
      type: 'host_call' as const,
      runId,
      callId: `${runId}:one`,
      operation: 'tts.synthesize' as const,
      args: {}
    }
    child.emit(frame)
    expect(await outcome).toMatchObject({ message: 'transport closed' })
    child.emit(frame)
    child.emit({ type: 'tts_result', runId, result: { completed: true } })
    expect(synthesize).toHaveBeenCalledOnce()
    expect(verifyCompletion).not.toHaveBeenCalled()
    expect(child.sent.filter((frame) => frame.type === 'host_result')).toHaveLength(1)
  } finally {
    await runtime.dispose()
  }
})

it.each(['out-of-order', 'duplicate-event', 'mismatched-text', 'overflow'] as const)(
  'keeps streamed conversation checks (%s)',
  async (mode) => {
    const child = new ControlledProcess()
    const runtime = controlledRuntime(child)
    const entry = runtimeCases.find((item) => item.task === 'conversation')!
    const outcome = entry.run(runtime, vi.fn()).catch((error: unknown) => error)
    try {
      await tick()
      const { runId } = sentRun(child)
      const frame = {
        type: 'event' as const,
        runId,
        seq: mode === 'out-of-order' ? 2 : 1,
        event: { type: 'text' as const, delta: mode === 'overflow' ? 'x'.repeat(32769) : 'answer' }
      }
      child.emit(frame)
      if (mode === 'duplicate-event') child.emit(frame)
      if (mode === 'mismatched-text') child.emit({ type: 'result', runId, text: 'other answer' })
      expect(await outcome).toMatchObject({
        code: mode === 'overflow' ? 'AGENT_LIMIT' : 'AGENT_PROTOCOL_ERROR'
      })
    } finally {
      await runtime.dispose()
    }
  }
)
