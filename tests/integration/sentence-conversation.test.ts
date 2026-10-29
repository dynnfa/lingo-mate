import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { openDatabase } from '../../src/database/database'
import { SqliteSentenceRepository } from '../../src/database/sqlite-sentence-repository'
import { SqliteConversationRepository } from '../../src/database/sqlite-conversation-repository'
import type { ConversationSkillRunInput } from '../../src/core/conversation/conversation-skill'
import type { SentenceAgentRuntime } from '../../src/core/agent/agent-runtime'
import { SentenceConversationSkill } from '../../src/core/learning/sentence/sentence-conversation-skill'
import { createTestConversationModule } from '../fixtures/conversation'
import { createSentenceFeedbackFormatter } from '../../src/main/sentence-feedback'
import type { ConversationEvent } from '../../src/shared/conversation'

const db = openDatabase(':memory:')
const repository = new SqliteSentenceRepository(db)
const conversations = new SqliteConversationRepository(db)
afterEach(() => {
  db.exec('DELETE FROM sentence')
  vi.restoreAllMocks()
})
afterAll(() => db.close())
const runtime: SentenceAgentRuntime = {
  async runSentence(input, host) {
    if (!host.prepare().existing)
      await host.model({ systemPrompt: 'Bound test fixture; output English.' }, input.signal, 65536)
    host.verifyCompletion({ completed: true })
  }
}
async function input(
  text = '原文\n第二行',
  signal = new AbortController().signal
): Promise<ConversationSkillRunInput> {
  const executionId = randomUUID(),
    sessionId = randomUUID(),
    userMessageId = randomUUID(),
    stamp = new Date().toISOString()
  const args = { text, wordLanguage: 'en' as const }
  await conversations.createExecution(
    {
      id: executionId,
      sessionId,
      userMessageId,
      skillId: 'sentence',
      arguments: args,
      explanationLanguage: 'en',
      phase: 'started',
      createdAt: stamp,
      updatedAt: stamp
    },
    { id: userMessageId, sessionId, role: 'user', content: `/sentence ${text}`, createdAt: stamp },
    { id: sessionId, title: 'Test', createdAt: stamp, updatedAt: stamp }
  )
  return {
    executionId,
    sessionId,
    userMessageId,
    requestId: randomUUID(),
    arguments: args,
    explanationLanguage: 'en',
    signal,
    onPhase: vi.fn()
  }
}
function skill(
  translate = vi.fn(async () => 'Natural wording.'),
  engine = runtime
): { skill: SentenceConversationSkill; translate: typeof translate } {
  return {
    skill: new SentenceConversationSkill(
      repository,
      () => ({ translate }),
      engine,
      createSentenceFeedbackFormatter()
    ),
    translate
  }
}

it('serializes concurrent identical requests until commit and uses a single translation', async () => {
  let release!: (text: string) => void
  const translate = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve
      })
  )
  const instance = skill(translate)
  const first = instance.skill.run(await input())
  await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1))
  const second = instance.skill.run(await input())
  release('Natural wording.')
  expect(await first).toMatchObject({ outcome: 'completed', report: { status: 'saved' } })
  expect(await second).toMatchObject({ outcome: 'completed', report: { status: 'existing' } })
  expect(translate).toHaveBeenCalledTimes(1)
})
it('cancels a queued duplicate without letting successors overtake the first request', async () => {
  let release!: (text: string) => void
  const translate = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve
      })
  )
  const instance = skill(translate)
  const first = instance.skill.run(await input())
  await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1))
  const controller = new AbortController()
  const cancelled = instance.skill.run(await input(undefined, controller.signal))
  const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejection
  const third = instance.skill.run(await input())
  release('Natural wording.')
  await first
  expect(await third).toMatchObject({ report: { status: 'existing' } })
  expect(translate).toHaveBeenCalledTimes(1)
})
it('discards late model output after cancellation and permits a new explicit request', async () => {
  let release!: (text: string) => void
  const translate = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve
      })
  )
  const instance = skill(translate)
  const controller = new AbortController()
  const pending = instance.skill.run(await input(undefined, controller.signal))
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1))
  controller.abort()
  release('Late result')
  await rejection
  expect(repository.list({}).entries).toEqual([])
  expect(await skill().skill.run(await input())).toMatchObject({ report: { status: 'saved' } })
})
it('rejects premature runtime success without storing anything', async () => {
  const engine: SentenceAgentRuntime = { runSentence: async () => {} }
  await expect(
    skill(
      vi.fn(async () => 'Unused'),
      engine
    ).skill.run(await input())
  ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
  expect(repository.list({}).entries).toEqual([])
})
it('translates again after deletion while preserving internal whitespace and casing', async () => {
  const instance = skill()
  await instance.skill.run(await input('  I  very like it.\nNext Line  '))
  const saved = repository.list({}).entries[0]
  expect(saved.sourceText).toBe('I  very like it.\nNext Line')
  repository.delete(saved.id)
  await instance.skill.run(await input('I  very like it.\nNext Line'))
  expect(instance.translate).toHaveBeenCalledTimes(2)
})
function terminal(
  start: (emit: (event: ConversationEvent) => void) => Promise<unknown>
): Promise<ConversationEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ConversationEvent[] = []
    void start((event) => {
      events.push(event)
      if (['completed', 'failed', 'cancelled'].includes(event.type)) resolve(events)
    }).catch(reject)
  })
}
it('restores a committed reply after failure without translating or recreating a deleted record', async () => {
  const instance = skill()
  const module = createTestConversationModule(
    {
      async *streamReply() {
        yield { type: 'text', delta: 'Title' }
      }
    },
    conversations,
    () => ({ outputLanguage: 'en', targetLanguage: 'en' }),
    new Map([['sentence', instance.skill]]),
    conversations
  )
  const original = conversations.finishExecution.bind(conversations)
  vi.spyOn(conversations, 'finishExecution')
    .mockRejectedValueOnce(new Error('temporary storage failure'))
    .mockImplementation(original)
  const { sessionId } = await module.createConversation()
  const first = await terminal((emit) =>
    module.runSkill(
      {
        requestId: randomUUID(),
        sessionId,
        skillId: 'sentence',
        arguments: { text: '原文', wordLanguage: 'en' }
      },
      emit
    )
  )
  expect(first.at(-1)).toMatchObject({ type: 'failed', error: { code: 'PERSISTENCE_ERROR' } })
  const history = await module.loadConversation(sessionId)
  expect(history.messages[0].retryable).toBe(true)
  repository.delete(repository.list({}).entries[0].id)
  const retry = await terminal((emit) =>
    module.retryMessage(
      { requestId: randomUUID(), sessionId, userMessageId: history.messages[0].messageId },
      emit
    )
  )
  expect(retry.at(-1)).toMatchObject({ type: 'completed' })
  expect(instance.translate).toHaveBeenCalledTimes(1)
  expect(repository.list({}).entries).toEqual([])
  expect((await module.loadConversation(sessionId)).messages.at(-1)?.content).toContain(
    'Natural wording'
  )
  await module.shutdown()
})

it('starts the total deadline when the key lock is acquired, before phase preparation', async () => {
  const controller = new AbortController()
  const bound = await input(undefined, controller.signal)
  let engineSignal: AbortSignal | undefined
  let releasePhase!: () => void
  bound.onPhase = () =>
    new Promise<void>((resolve) => {
      releasePhase = resolve
    })
  const engine: SentenceAgentRuntime = {
    async runSentence(_input) {
      engineSignal = _input.signal
      _input.signal.throwIfAborted()
    }
  }
  vi.useFakeTimers()
  const running = skill(
    vi.fn(async () => 'unused'),
    engine
  ).skill.run(bound)
  const rejection = expect(running).rejects.toMatchObject({ code: 'AGENT_LIMIT' })
  try {
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(120_000)
    releasePhase()
    await rejection
    expect(engineSignal?.aborted).toBe(true)
    expect(repository.list({}).entries).toEqual([])
  } finally {
    controller.abort()
    releasePhase?.()
    await running.catch(() => {})
    vi.useRealTimers()
  }
})
