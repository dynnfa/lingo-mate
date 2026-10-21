import { openDatabase } from '../../src/database/database'
import { SqliteVocabularyRepository } from '../../src/database/sqlite-vocabulary-repository'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { VocabularyHostSession } from '../../src/core/learning/vocabulary/vocabulary-host'
import {
  insertResult,
  memoryRepository
} from '../../src/core/learning/vocabulary/__tests__/fixtures'

export function vocabularyRuntime(): PythonAgentRuntime {
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

describe('vocabulary LangGraph over real JSONL', () => {
  it('stages learning content locally and commits only after a verified Python completion', async () => {
    const repository = memoryRepository()
    const analyze = vi.fn(async ({ term }) => insertResult(term))
    const host = new VocabularyHostSession(
      repository,
      () => ({ analyze }),
      'apple,banana,apple',
      'en',
      'zh-CN'
    )
    const runtime = vocabularyRuntime()
    try {
      await runtime.runVocabulary(
        { outputLanguage: 'zh-CN', targetLanguage: 'en', signal: new AbortController().signal },
        host
      )
      expect(repository.commands).toEqual([])
      const report = host.commit(crypto.randomUUID())
      expect(report.counts).toMatchObject({ saved: 2, duplicate: 1 })
      expect(analyze).toHaveBeenCalledTimes(2)
      expect(analyze.mock.calls[0][0].systemPrompt).toContain('Simplified Chinese (zh-CN)')
    } finally {
      await runtime.dispose()
    }
  })
})

it('processes 20 terms with exactly two concurrent calls and one immutable model snapshot', async () => {
  const database = openDatabase(':memory:')
  const repository = new SqliteVocabularyRepository(database)
  const runtime = vocabularyRuntime()
  let active = 0
  let peak = 0
  let modelId = 'initial-model'
  const createAnalyzer = vi.fn(() => {
    const snapshot = modelId
    return {
      analyze: async ({ term, systemPrompt }: { term: string; systemPrompt: string }) => {
        expect(systemPrompt).toContain('written in English (en)')
        active++
        peak = Math.max(peak, active)
        modelId = 'changed-during-batch'
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return { ...insertResult(term), modelId: snapshot }
      }
    }
  })
  const terms = Array.from({ length: 20 }, (_, i) => `word${i}`).join(',')
  const host = new VocabularyHostSession(repository, createAnalyzer, terms, 'en', 'en')
  try {
    await runtime.runVocabulary(
      { outputLanguage: 'en', targetLanguage: 'en', signal: new AbortController().signal },
      host
    )
    expect(peak).toBe(2)
    expect(createAnalyzer).toHaveBeenCalledTimes(1)
    expect(host.commit(crypto.randomUUID()).counts.saved).toBe(20)
    expect(database.prepare('SELECT DISTINCT model_id FROM vocabulary').all()).toEqual([
      { model_id: 'initial-model' }
    ])
    const again = new VocabularyHostSession(repository, createAnalyzer, terms, 'en', 'en')
    await runtime.runVocabulary(
      { outputLanguage: 'en', targetLanguage: 'en', signal: new AbortController().signal },
      again
    )
    expect(again.commit(crypto.randomUUID()).counts.existing).toBe(20)
    expect(createAnalyzer).toHaveBeenCalledTimes(1)
  } finally {
    await runtime.dispose()
    database.close()
  }
})

it.each([
  'cross-run',
  'cross-call',
  'premature-result',
  'forbidden-operation',
  'invalid-index',
  'duplicate-index',
  'excess-concurrency'
])('rejects %s from a child without committing staged content', async (mode) => {
  const child = new PythonAgentProcess({
    command: resolve(
      'agent-engine/.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    ),
    args: ['-I', resolve('tests/integration/fixtures/agent/vocabulary-fault-engine.py'), mode]
  })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('forbidden')
  })
  const repository = memoryRepository()
  const signals: AbortSignal[] = []
  const analyze = vi.fn(async ({ term, signal }) => {
    signals.push(signal)
    if (mode === 'excess-concurrency') return new Promise<ReturnType<typeof insertResult>>(() => {})
    return insertResult(term)
  })
  const host = new VocabularyHostSession(
    repository,
    () => ({ analyze }),
    'apple,banana,orange',
    'en',
    'en'
  )
  try {
    await expect(
      runtime.runVocabulary(
        { outputLanguage: 'en', targetLanguage: 'en', signal: new AbortController().signal },
        host
      )
    ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
    expect(repository.commands).toHaveLength(0)
    expect(() => host.commit(crypto.randomUUID())).toThrow()
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
  const analyze = vi.fn(async ({ term, signal }) => {
    signals.push(signal)
    if (term === 'banana') return new Promise<ReturnType<typeof insertResult>>(() => {})
    return insertResult(term)
  })
  const host = new VocabularyHostSession(
    repository,
    () => ({ analyze }),
    'apple,banana',
    'en',
    'en'
  )
  const input = { outputLanguage: 'en', targetLanguage: 'en', signal: new AbortController().signal }
  try {
    const pending = runtime.runVocabulary(input, host)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2))
    process.kill(child.pid!, 'SIGKILL')
    await rejected
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(repository.commands).toHaveLength(0)
    expect(() => host.commit(crypto.randomUUID())).toThrow()
    expect(analyze).toHaveBeenCalledTimes(2)
    const next = new VocabularyHostSession(
      repository,
      () => ({ analyze: async ({ term }) => insertResult(term) }),
      'apple',
      'en',
      'en'
    )
    await runtime.runVocabulary(input, next)
    expect(next.commit(crypto.randomUUID()).counts.saved).toBe(1)
    expect(child.handshakes).toBe(2)
    expect(analyze).toHaveBeenCalledTimes(2)
  } finally {
    await runtime.dispose()
  }
})

it('sends only terms, receipts and language snapshots across the Python boundary', async () => {
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
  const host = new VocabularyHostSession(
    repository,
    () => ({
      analyze: async ({ term }) => {
        const result = insertResult(term)
        if (result.status !== 'insert') throw new Error('fixture')
        result.content.meaning = 'private-validated-content'
        result.modelId = 'private-model-identity'
        return result
      }
    }),
    'apple',
    'en',
    'en'
  )
  try {
    await runtime.runVocabulary(
      { outputLanguage: 'en', targetLanguage: 'en', signal: new AbortController().signal },
      host
    )
    host.commit(crypto.randomUUID())
    const wire = JSON.stringify(sent)
    expect(wire).not.toMatch(
      /private-validated-content|private-model-identity|sessionId|executionId|apiKey|entryId/
    )
    expect(wire).toContain('apple')
    expect(wire).toContain('staged')
  } finally {
    await runtime.dispose()
  }
})
