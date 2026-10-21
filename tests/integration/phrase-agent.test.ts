import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { PhraseHostSession } from '../../src/core/learning/phrase/phrase-host'
import { insertResult, memoryRepository } from '../../src/core/learning/phrase/__tests__/fixtures'

export function phraseRuntime(): PythonAgentRuntime {
  return new PythonAgentRuntime(
    new PythonAgentProcess({
      command: resolve(
        'agent-engine/.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      ),
      args: ['-I', '-m', 'lingo_agent']
    }),
    () => {
      throw new Error('Conversation model must not be used')
    }
  )
}

describe('phrase LangGraph over real JSONL', () => {
  it('stages learning content locally and commits only after a verified Python completion', async () => {
    const repository = memoryRepository()
    const analyze = vi.fn(async ({ phrase }) => insertResult(phrase))
    const host = new PhraseHostSession(
      repository,
      () => ({ analyze }),
      'look forward to\nbreak even\nlook forward to',
      'en',
      'zh-CN'
    )
    const runtime = phraseRuntime()
    try {
      await runtime.runPhrase(
        { outputLanguage: 'zh-CN', targetLanguage: 'en', signal: new AbortController().signal },
        host
      )
      expect(repository.contents).toEqual([])
      const report = host.commit(crypto.randomUUID(), crypto.randomUUID())
      expect(report.counts).toMatchObject({ saved: 2, duplicate: 1 })
      expect(analyze).toHaveBeenCalledTimes(2)
      expect(analyze.mock.calls[0][0].systemPrompt).toContain('Simplified Chinese (zh-CN)')
    } finally {
      await runtime.dispose()
    }
  })
})

it('processes 20 phrases with exactly two concurrent calls and one immutable model snapshot', async () => {
  const repository = memoryRepository()
  const runtime = phraseRuntime()
  let active = 0
  let peak = 0
  let modelId = 'initial-model'
  const snapshots: string[] = []
  const createAnalyzer = vi.fn(() => {
    const snapshot = modelId
    return {
      analyze: async ({ phrase, systemPrompt }: { phrase: string; systemPrompt: string }) => {
        expect(systemPrompt).toContain('written in English (en)')
        snapshots.push(snapshot)
        active++
        peak = Math.max(peak, active)
        modelId = 'changed-during-batch'
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return insertResult(phrase)
      }
    }
  })
  const phrases = Array.from({ length: 20 }, (_, i) => `phrase ${i}`).join('\n')
  const host = new PhraseHostSession(repository, createAnalyzer, phrases, 'en', 'en')
  try {
    await runtime.runPhrase(
      { outputLanguage: 'en', targetLanguage: 'en', signal: new AbortController().signal },
      host
    )
    expect(peak).toBe(2)
    expect(createAnalyzer).toHaveBeenCalledTimes(1)
    expect(snapshots).toEqual(Array(20).fill('initial-model'))
    expect(host.commit(crypto.randomUUID(), crypto.randomUUID()).counts.saved).toBe(20)
    const again = new PhraseHostSession(repository, createAnalyzer, phrases, 'en', 'en')
    await runtime.runPhrase(
      { outputLanguage: 'en', targetLanguage: 'en', signal: new AbortController().signal },
      again
    )
    expect(again.commit(crypto.randomUUID(), crypto.randomUUID()).counts.existing).toBe(20)
    expect(createAnalyzer).toHaveBeenCalledTimes(1)
  } finally {
    await runtime.dispose()
  }
})

it.each([
  'cross-run',
  'cross-call',
  'premature-result',
  'forbidden-operation',
  'vocabulary-operation',
  'wrong-result',
  'invalid-index',
  'duplicate-index',
  'excess-concurrency'
])('rejects %s from a child without committing staged content', async (mode) => {
  const child = new PythonAgentProcess({
    command: resolve(
      'agent-engine/.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    ),
    args: ['-I', resolve('tests/integration/fixtures/agent/phrase-fault-engine.py'), mode]
  })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('forbidden')
  })
  const repository = memoryRepository()
  const signals: AbortSignal[] = []
  const analyze = vi.fn(async ({ phrase, signal }) => {
    signals.push(signal)
    if (mode === 'excess-concurrency') return new Promise<ReturnType<typeof insertResult>>(() => {})
    return insertResult(phrase)
  })
  const host = new PhraseHostSession(
    repository,
    () => ({ analyze }),
    'look forward to\nbreak even\npiece of cake',
    'en',
    'en'
  )
  try {
    await expect(
      runtime.runPhrase(
        { outputLanguage: 'en', targetLanguage: 'en', signal: new AbortController().signal },
        host
      )
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    expect(repository.contents).toHaveLength(0)
    expect(() => host.commit(crypto.randomUUID(), crypto.randomUUID())).toThrow()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(analyze.mock.calls.length).toBeLessThanOrEqual(
      mode === 'excess-concurrency' ? 2 : mode === 'duplicate-index' ? 1 : 0
    )
  } finally {
    await runtime.dispose()
  }
})

it('discards staged results on a real engine crash and restarts only for a new request', async () => {
  const child = new PythonAgentProcess({
    command: resolve(
      'agent-engine/.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    ),
    args: ['-I', '-m', 'lingo_agent']
  })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('forbidden')
  })
  const repository = memoryRepository()
  const signals: AbortSignal[] = []
  const analyze = vi.fn(async ({ phrase, signal }) => {
    signals.push(signal)
    if (phrase === 'break even') return new Promise<ReturnType<typeof insertResult>>(() => {})
    return insertResult(phrase)
  })
  const host = new PhraseHostSession(
    repository,
    () => ({ analyze }),
    'look forward to\nbreak even',
    'en',
    'en'
  )
  const input = { outputLanguage: 'en', targetLanguage: 'en', signal: new AbortController().signal }
  try {
    const pending = runtime.runPhrase(input, host)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2))
    process.kill(child.pid!, 'SIGKILL')
    await rejected
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(repository.contents).toHaveLength(0)
    expect(() => host.commit(crypto.randomUUID(), crypto.randomUUID())).toThrow()
    expect(analyze).toHaveBeenCalledTimes(2)
    const next = new PhraseHostSession(
      repository,
      () => ({ analyze: async ({ phrase }) => insertResult(phrase) }),
      'look forward to',
      'en',
      'en'
    )
    await runtime.runPhrase(input, next)
    expect(next.commit(crypto.randomUUID(), crypto.randomUUID()).counts.saved).toBe(1)
    expect(child.handshakes).toBe(2)
    expect(analyze).toHaveBeenCalledTimes(2)
  } finally {
    await runtime.dispose()
  }
})

it('sends only phrases, receipts and language snapshots across the Python boundary', async () => {
  const child = new PythonAgentProcess({
    command: resolve(
      'agent-engine/.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    ),
    args: ['-I', '-m', 'lingo_agent']
  })
  const sent: unknown[] = []
  const original = child.send.bind(child)
  vi.spyOn(child, 'send').mockImplementation(async (frame, control) => {
    sent.push(structuredClone(frame))
    await original(frame, control)
  })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('forbidden')
  })
  const repository = memoryRepository()
  const host = new PhraseHostSession(
    repository,
    () => ({
      analyze: async ({ phrase }) => {
        const result = insertResult(phrase)
        if (result.status !== 'insert') throw new Error('fixture')
        result.content.explantation = 'private-validated-content'
        result.modelId = 'private-model-identity'
        return result
      }
    }),
    'look forward to',
    'en',
    'en'
  )
  try {
    await runtime.runPhrase(
      { outputLanguage: 'en', targetLanguage: 'en', signal: new AbortController().signal },
      host
    )
    host.commit(crypto.randomUUID(), crypto.randomUUID())
    const wire = JSON.stringify(sent)
    expect(wire).not.toMatch(
      /private-validated-content|private-model-identity|sessionId|executionId|apiKey|entryId/
    )
    expect(wire).toContain('look forward to')
    expect(wire).toContain('staged')
  } finally {
    await runtime.dispose()
  }
})
