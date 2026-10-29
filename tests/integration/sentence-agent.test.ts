import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { SentenceConversationSkill } from '../../src/core/learning/sentence/sentence-conversation-skill'
import { LlmSentenceTranslator } from '../../src/core/learning/sentence/llm-sentence-translator'
import { SqliteSentenceRepository } from '../../src/database/sqlite-sentence-repository'
import { SqliteConversationRepository } from '../../src/database/sqlite-conversation-repository'
import { openDatabase } from '../../src/database/database'
import { isSentenceReport, type SentenceReport } from '../../src/shared/sentence'

const python = resolve(
  'agent-engine/.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
)

it('translates a whole paragraph through Python, then reuses it without exposing content on the wire', async () => {
  const db = openDatabase(':memory:')
  const process = new PythonAgentProcess({
    command: python,
    args: ['-I', '-m', 'lingo_agent']
  })
  const runtime = new PythonAgentRuntime(process, () => {
    throw new Error('Unused')
  })
  const wire = vi.spyOn(process, 'send')
  const source = '今天先这样吧。\n剩下的我们明天再说。'
  const translation = "Let's call it a day.\nWe can pick this up tomorrow."
  const complete = vi.fn().mockResolvedValue({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translation }) } }]
  })
  const skill = new SentenceConversationSkill(
    new SqliteSentenceRepository(db),
    () =>
      new LlmSentenceTranslator(
        {
          configured: true,
          protocol: 'openai-compatible',
          baseUrl: 'http://localhost/v1',
          modelId: 'fake',
          apiKey: undefined
        },
        () => ({ complete, stream: vi.fn() })
      ),
    runtime,
    (report) => report.entry.translation
  )
  const conversations = new SqliteConversationRepository(db)
  const run = async (): Promise<SentenceReport> => {
    const now = new Date().toISOString()
    const sessionId = randomUUID(),
      userMessageId = randomUUID(),
      executionId = randomUUID()
    await conversations.createExecution(
      {
        id: executionId,
        sessionId,
        userMessageId,
        skillId: 'sentence',
        arguments: { text: source, wordLanguage: 'en' },
        explanationLanguage: 'zh-CN',
        phase: 'started',
        createdAt: now,
        updatedAt: now
      },
      {
        id: userMessageId,
        sessionId,
        role: 'user',
        content: `/sentence ${source}`,
        createdAt: now
      },
      { id: sessionId, title: 'Test', createdAt: now, updatedAt: now }
    )
    const result = await skill.run({
      requestId: randomUUID(),
      executionId,
      sessionId,
      userMessageId,
      arguments: { text: source, wordLanguage: 'en' },
      explanationLanguage: 'zh-CN',
      signal: new AbortController().signal,
      onPhase: vi.fn()
    })
    if (result.outcome !== 'completed' || !isSentenceReport(result.report))
      throw new Error('Missing report')
    return result.report
  }
  try {
    expect(await run()).toMatchObject({
      status: 'saved',
      entry: { sourceText: source, translation }
    })
    expect(await run()).toMatchObject({ status: 'existing', entry: { translation } })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0][0].messages[0].content).toContain('native speaker')
    expect(complete.mock.calls[0][0].messages[0].content).toContain('English')
    expect(JSON.stringify(wire.mock.calls)).not.toContain(source)
    expect(JSON.stringify(wire.mock.calls)).not.toContain(translation)
  } finally {
    await runtime.dispose()
    db.close()
  }
})

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
])('rejects an untrusted sentence engine: %s', async (mode) => {
  const child = new PythonAgentProcess({
    command: python,
    args: ['-I', resolve('tests/integration/fixtures/agent/sentence-fault-engine.py'), mode]
  })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('Unused')
  })
  const verifyCompletion = vi.fn()
  try {
    await expect(
      runtime.runSentence(
        { outputLanguage: 'en', targetLanguage: 'en', signal: new AbortController().signal },
        {
          prepare: () => ({ existing: false, inputChars: 10 }),
          model: async () =>
            mode === 'excess-concurrency' ? new Promise(() => {}) : { completed: true },
          verifyCompletion
        }
      )
    ).rejects.toHaveProperty(
      'code',
      mode === 'engine-failure'
        ? 'AGENT_HOST_ERROR'
        : mode === 'duplicate-model'
          ? 'AGENT_LIMIT'
          : 'AGENT_PROTOCOL_ERROR'
    )
    expect(verifyCompletion).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
})
