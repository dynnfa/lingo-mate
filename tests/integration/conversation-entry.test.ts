import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi, type MockInstance } from 'vitest'
import type Database from 'better-sqlite3'
import { ConversationModule } from '../../src/core/conversation/conversation-module'
import type { ConversationSkill } from '../../src/core/conversation/conversation-skill'
import { ConversationBusyError } from '../../src/core/conversation/conversation-repository'
import { LlmClient, ModelRequestError } from '../../src/core/llm/llm-client'
import { LlmUsageRecorder } from '../../src/core/llm/llm-usage-recorder'
import type { LanguageModel } from '../../src/core/llm/language-model'
import { RemoteLanguageModel } from '../../src/core/llm/remote-language-model'
import { ExplorePhraseConversationSkill } from '../../src/core/learning/explore-phrase/explore-phrase-conversation-skill'
import { ExplorePhraseModule } from '../../src/core/learning/explore-phrase/explore-phrase-module'
import { ExploreVocabularyConversationSkill } from '../../src/core/learning/explore-vocabulary/explore-vocabulary-conversation-skill'
import { ExploreVocabularyModule } from '../../src/core/learning/explore-vocabulary/explore-vocabulary-module'
import { insertResult as phraseResult } from '../../src/core/learning/phrase/__tests__/fixtures'
import { PhraseConversationSkill } from '../../src/core/learning/phrase/phrase-conversation-skill'
import { SentenceConversationSkill } from '../../src/core/learning/sentence/sentence-conversation-skill'
import type { SynonymAnalyzer } from '../../src/core/learning/synonym/synonym-analyzer'
import { SynonymConversationSkill } from '../../src/core/learning/synonym/synonym-conversation-skill'
import { SynonymModule } from '../../src/core/learning/synonym/synonym-module'
import { insertResult as vocabularyResult } from '../../src/core/learning/vocabulary/__tests__/fixtures'
import { VocabularyConversationSkill } from '../../src/core/learning/vocabulary/vocabulary-conversation-skill'
import { TtsConversationSkill } from '../../src/core/speech/tts-conversation-skill'
import { joinSpeechPcm } from '../../src/core/speech/speech-audio'
import { openDatabase } from '../../src/database/database'
import { SqliteConversationRepository } from '../../src/database/sqlite-conversation-repository'
import { SqliteLlmUsageRepository } from '../../src/database/sqlite-llm-usage-repository'
import { SqlitePhraseRepository } from '../../src/database/sqlite-phrase-repository'
import { SqliteSentenceRepository } from '../../src/database/sqlite-sentence-repository'
import { SqliteSynonymRepository } from '../../src/database/sqlite-synonym-repository'
import { SqliteTtsRepository } from '../../src/database/sqlite-tts-repository'
import { SqliteVocabularyRepository } from '../../src/database/sqlite-vocabulary-repository'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { toSafeRequestError } from '../../src/main/conversation-errors'
import { createExplorePhraseFeedbackFormatter } from '../../src/main/explore-phrase-feedback'
import { JsonFileExplorePhraseHistoryStore } from '../../src/main/explore-phrase-history-store'
import { createExploreVocabularyFeedbackFormatter } from '../../src/main/explore-vocabulary-feedback'
import { JsonFileExploreVocabularyHistoryStore } from '../../src/main/explore-vocabulary-history-store'
import { createPhraseFeedbackFormatter } from '../../src/main/phrase-feedback'
import { createSentenceFeedbackFormatter } from '../../src/main/sentence-feedback'
import { createSynonymFeedbackFormatter } from '../../src/main/synonym-feedback'
import { createVocabularyFeedbackFormatter } from '../../src/main/vocabulary-feedback'
import type { ConversationEvent, GenerationAccepted } from '../../src/shared/conversation'
import { SPEECH_IDENTITY, type SpeechInput } from '../../src/shared/speech'

function harness(
  streamReply: LanguageModel['streamReply'],
  path = ':memory:'
): {
  db: Database.Database
  repository: SqliteConversationRepository
  runtime: PythonAgentRuntime
  wire: MockInstance<PythonAgentProcess['send']>
} {
  const db = openDatabase(path)
  const repository = new SqliteConversationRepository(db)
  const child = new PythonAgentProcess({
    command: resolve(
      'agent-engine/.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    ),
    args: ['-I', '-m', 'lingo_agent']
  })
  const wire = vi.spyOn(child, 'send')
  const runtime = new PythonAgentRuntime(child, () => ({ streamReply }))
  return { db, repository, runtime, wire }
}

async function terminal(
  start: (emit: (event: ConversationEvent) => void) => Promise<GenerationAccepted>
): Promise<GenerationAccepted & { events: ConversationEvent[] }> {
  const events: ConversationEvent[] = []
  const accepted = await start((event) => events.push(event))
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe('completed'))
  return { ...accepted, events }
}

it('binds all eight explicit commands to only their real Python workflows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lingo-conversation-entry-'))
  const { db, repository, runtime, wire } = harness(async function* ({ purpose }) {
    expect(purpose).toBe('conversation')
    yield { type: 'text', delta: 'A concept explanation.' }
  })
  const translate = vi.fn(async () => 'Natural wording.')
  const vocabulary = new SqliteVocabularyRepository(db)
  const phrases = new SqlitePhraseRepository(db)
  const sentences = new SqliteSentenceRepository(db)
  const synonyms = new SqliteSynonymRepository(db)
  const speech = new SqliteTtsRepository(db)
  const explorePhrases = new JsonFileExplorePhraseHistoryStore(join(directory, 'phrase.json'))
  const exploreVocabulary = new JsonFileExploreVocabularyHistoryStore(
    join(directory, 'vocabulary.json')
  )
  const analyzeSynonym: SynonymAnalyzer['analyze'] = async ({ messages }) => {
    const queried = messages.at(-1)?.role === 'tool'
    const args = queried
      ? {
          word: 'adequate',
          meaning: 'acceptable',
          groupMeaning: 'acceptable',
          distinction: 'neutral register'
        }
      : { word: 'adequate', meaning: 'acceptable' }
    return {
      canCorrectParallel: false,
      message: {
        tool_calls: [
          {
            id: randomUUID(),
            type: 'function',
            function: {
              name: queried ? 'create_synonym_group_and_add_word' : 'find_synonym_groups',
              arguments: JSON.stringify(args)
            }
          }
        ]
      }
    }
  }
  const synthesize = vi.fn(async (input: SpeechInput) => ({
    ...input,
    settings: { voice: 'af_bella' as const, speed: 1 },
    identity: SPEECH_IDENTITY.revision,
    audio: new Uint8Array(joinSpeechPcm([new Uint8Array(48000)])),
    durationSeconds: 1,
    words: [
      { index: 0, text: 'Hello', charStart: 1, charEnd: 6, startSeconds: 0.1, endSeconds: 0.8 }
    ]
  }))
  const skills: ConversationSkill[] = [
    new VocabularyConversationSkill(
      vocabulary,
      () => ({
        analyzer: {
          analyze: async ({ term }) => vocabularyResult(term)
        }
      }),
      createVocabularyFeedbackFormatter(),
      runtime
    ),
    new PhraseConversationSkill(
      phrases,
      () => ({
        analyze: async ({ phrase }) => phraseResult(phrase)
      }),
      createPhraseFeedbackFormatter(),
      runtime
    ),
    new SentenceConversationSkill(
      sentences,
      () => ({ translate }),
      runtime,
      createSentenceFeedbackFormatter()
    ),
    new SynonymConversationSkill(
      new SynonymModule(synonyms, () => ({ analyze: analyzeSynonym }), runtime),
      createSynonymFeedbackFormatter()
    ),
    new TtsConversationSkill(speech, { synthesize }, runtime),
    new ExplorePhraseConversationSkill(
      new ExplorePhraseModule(
        explorePhrases,
        () => ({
          generate: async () =>
            Array.from({ length: 10 }, (_, index) => ({
              phrase: `pick option ${index}`,
              explanation: 'Pick an option.',
              example: `You can pick option ${index} today.`
            }))
        }),
        runtime
      ),
      createExplorePhraseFeedbackFormatter()
    ),
    new ExploreVocabularyConversationSkill(
      new ExploreVocabularyModule(
        exploreVocabulary,
        () => ({
          generate: async () =>
            [
              'apple',
              'carry',
              'bright',
              'drift',
              'entry',
              'forest',
              'gentle',
              'honey',
              'invent',
              'jump'
            ].map((term) => ({
              term,
              explanation: 'A definition.',
              example: `The target word is ${term}.`
            }))
        }),
        runtime
      ),
      createExploreVocabularyFeedbackFormatter()
    )
  ]
  const module = new ConversationModule(
    repository,
    runtime,
    undefined,
    new Map(skills.map((skill) => [skill.skillId, skill])),
    repository
  )
  const sessionId = randomUUID()
  try {
    await module.createPersistentConversation(sessionId, 'Entry integration')
    const cases = [
      ['concept', ''],
      ['vocabulary', 'apple，banana'],
      ['phrase', 'look forward to\nif anything, at all'],
      ['synonym', 'adequate'],
      ['explore-phrase', ''],
      ['explore-vocabulary', ''],
      ['sentence', '今天先这样。\n明天继续。'],
      ['tts', ' Hello world  ']
    ] as const
    const userIds = new Map<string, string>()
    for (const [task, body] of cases) {
      wire.mockClear()
      const { generation, events } = await terminal((emit) =>
        module.sendMessage(
          {
            requestId: randomUUID(),
            sessionId,
            text: body ? `\t/${task}\u3000${body}` : `/${task}`
          },
          emit
        )
      )
      userIds.set(task, generation.userMessage.messageId)
      const runs = wire.mock.calls.flatMap(([frame]) => (frame.type === 'run' ? [frame] : []))
      expect(runs.map(({ snapshot }) => snapshot.task)).toEqual(['conversation-route', task])
      expect(runs[0].runId).not.toBe(runs[1].runId)
      expect(JSON.stringify(runs[0].snapshot)).not.toContain(body || 'unused-marker')
      expect(events[0].type).toBe('started')
      expect(
        events.filter(({ type }) => ['completed', 'failed', 'cancelled'].includes(type))
      ).toHaveLength(1)
    }
    expect(
      vocabulary
        .list({})
        .entries.map(({ term }) => term)
        .sort()
    ).toEqual(['apple', 'banana'])
    expect(
      phrases
        .list({})
        .entries.map(({ phrase }) => phrase)
        .sort()
    ).toEqual(['if anything, at all', 'look forward to'])
    expect(synonyms.findExisting(['adequate']).has('adequate')).toBe(true)
    const phraseBatch = await explorePhrases.findBatchByUserMessage(userIds.get('explore-phrase')!)
    const vocabularyBatch = await exploreVocabulary.findBatchByUserMessage(
      userIds.get('explore-vocabulary')!
    )
    expect(phraseBatch?.items).toHaveLength(10)
    expect(vocabularyBatch?.items).toHaveLength(10)
    expect(
      await explorePhrases.findBatchByUserMessage(userIds.get('explore-vocabulary')!)
    ).toBeUndefined()
    expect(
      await exploreVocabulary.findBatchByUserMessage(userIds.get('explore-phrase')!)
    ).toBeUndefined()
    expect(synthesize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: ' Hello world  ' }),
      expect.anything()
    )

    // The typed compatibility input selects the same workflow and reuses the committed sentence.
    wire.mockClear()
    await terminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'sentence',
          arguments: { text: cases[6][1], wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(
      wire.mock.calls.flatMap(([frame]) => (frame.type === 'run' ? [frame.snapshot.task] : []))
    ).toEqual(['conversation-route', 'sentence'])
    expect(translate).toHaveBeenCalledTimes(1)
    expect(sentences.list({}).entries).toHaveLength(1)
    expect(await repository.history(sessionId)).toHaveLength(18)
  } finally {
    await module.shutdown()
    await runtime.dispose()
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)

it('holds the session during classification and cancels a pending draft before saving or starting', async () => {
  let providerSignal: AbortSignal | undefined
  const { db, repository, runtime, wire } = harness(async function* ({ purpose, signal }) {
    expect(purpose).toBe('conversation-route')
    providerSignal = signal
    await new Promise<void>((done) => {
      if (signal.aborted) done()
      else signal.addEventListener('abort', () => done(), { once: true })
    })
    yield { type: 'text', delta: 'concept' }
  })
  const module = new ConversationModule(repository, runtime)
  try {
    const { sessionId } = await module.createConversation()
    const requestId = randomUUID()
    const events: ConversationEvent[] = []
    const pending = module.sendMessage(
      { requestId, sessionId, text: 'What does carry out mean?' },
      (e) => events.push(e)
    )
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(providerSignal).toBeDefined())
    await expect(
      module.sendMessage({ requestId: randomUUID(), sessionId, text: '/sentence text' }, () => {})
    ).rejects.toBeInstanceOf(ConversationBusyError)
    module.cancelMessage(requestId)
    await rejection
    expect(providerSignal?.aborted).toBe(true)
    expect(events.map(({ type }) => type)).toEqual(['cancelled'])
    expect(await repository.find(sessionId)).toBeUndefined()
    expect((await module.loadConversation(sessionId)).messages).toEqual([])
    expect(
      wire.mock.calls.flatMap(([frame]) => (frame.type === 'run' ? [frame.snapshot.task] : []))
    ).toEqual(['conversation-route'])
  } finally {
    await module.shutdown()
    await runtime.dispose()
    db.close()
  }
})

it.each(['invalid response', 'TIMEOUT', 'NETWORK'] as const)(
  'emits one route failure and leaves the draft intact for %s',
  async (failure) => {
    const { db, repository, runtime, wire } = harness(async function* ({ purpose }) {
      expect(purpose).toBe('conversation-route')
      if (failure === 'TIMEOUT' || failure === 'NETWORK')
        throw new ModelRequestError(failure, new Error('Provider failure'))
      yield { type: 'text', delta: '{"kind":"workflow","workflow":"sentence"}' }
    })
    const module = new ConversationModule(repository, runtime)
    try {
      const { sessionId } = await module.createConversation()
      const events: ConversationEvent[] = []
      await expect(
        module.sendMessage({ sessionId, requestId: randomUUID(), text: 'Explain that' }, (e) =>
          events.push(e)
        )
      ).rejects.toBeInstanceOf(ModelRequestError)
      expect(events).toEqual([
        expect.objectContaining({ type: 'failed', error: { code: 'MODEL_ERROR' } })
      ])
      expect(await repository.find(sessionId)).toBeUndefined()
      expect((await module.loadConversation(sessionId)).messages).toEqual([])
      expect(
        wire.mock.calls.flatMap(([frame]) => (frame.type === 'run' ? [frame.snapshot.task] : []))
      ).toEqual(['conversation-route'])
    } finally {
      await module.shutdown()
      await runtime.dispose()
      db.close()
    }
  }
)

it('publishes one safe route failure when the provider rejects classification with HTTP 401', async () => {
  const { db, repository, runtime } = harness((input) => model.streamReply(input))
  const model = new RemoteLanguageModel(
    {
      configured: true,
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      modelId: 'fixture',
      apiKey: 'fixture'
    },
    undefined,
    (config) => new LlmClient(config, new LlmUsageRecorder(new SqliteLlmUsageRepository(db)))
  )
  const module = new ConversationModule(repository, runtime)
  const fetchMock = vi.fn(async () =>
    Response.json({ error: { message: 'Provider denied the request' } }, { status: 401 })
  )
  vi.stubGlobal('fetch', fetchMock)
  try {
    const { sessionId } = await module.createConversation()
    const requestId = randomUUID()
    const events: ConversationEvent[] = []
    const result = await module
      .sendMessage({ sessionId, requestId, text: 'Hello' }, (event) => events.push(event))
      .catch((error: unknown) => toSafeRequestError(error))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ code: 'MODEL_ERROR' })
    expect(events).toEqual([{ type: 'failed', sessionId, requestId, error: result }])
    expect(await repository.find(sessionId)).toBeUndefined()
    expect((await module.loadConversation(sessionId)).messages).toEqual([])
  } finally {
    vi.unstubAllGlobals()
    await module.shutdown()
    await runtime.dispose()
    db.close()
  }
})

it('retries a failed natural-language concept with the same workflow after reopening the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lingo-concept-retry-'))
  const path = join(directory, 'conversation.sqlite')
  const sessionId = randomUUID()
  const text = 'How do I use carry out?'
  try {
    const first = harness(async function* ({ purpose, systemPrompt }) {
      if (purpose === 'conversation-route') {
        yield { type: 'text', delta: 'concept' }
        return
      }
      expect(systemPrompt).toContain('the /concept command')
      throw new ModelRequestError('NETWORK', new Error('Provider disconnected'))
    }, path)
    const firstModule = new ConversationModule(first.repository, first.runtime)
    let userMessageId: string
    try {
      await firstModule.createPersistentConversation(sessionId, 'Existing')
      const events: ConversationEvent[] = []
      const { generation } = await firstModule.sendMessage(
        { sessionId, requestId: randomUUID(), text },
        (event) => events.push(event)
      )
      await vi.waitFor(() => expect(events.map(({ type }) => type)).toEqual(['started', 'failed']))
      userMessageId = generation.userMessage.messageId
    } finally {
      await firstModule.shutdown()
      await first.runtime.dispose()
      first.db.close()
    }

    const retryModel = vi.fn<LanguageModel['streamReply']>(async function* () {
      yield { type: 'text', delta: 'A concept explanation.' }
    })
    const retry = harness(retryModel, path)
    const retryModule = new ConversationModule(retry.repository, retry.runtime)
    try {
      await terminal((emit) =>
        retryModule.retryMessage({ sessionId, userMessageId, requestId: randomUUID() }, emit)
      )
      expect(retryModel).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          purpose: 'conversation',
          systemPrompt: expect.stringContaining('the /concept command'),
          messages: [{ role: 'user', content: text }]
        })
      )
      expect(
        retry.wire.mock.calls.flatMap(([frame]) =>
          frame.type === 'run' ? [frame.snapshot.task] : []
        )
      ).toEqual(['concept'])
      expect((await retry.repository.history(sessionId)).map(({ content }) => content)).toEqual([
        text,
        'A concept explanation.'
      ])
    } finally {
      await retryModule.shutdown()
      await retry.runtime.dispose()
      retry.db.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('retries an upgraded message-only record as ordinary conversation without creating a skill execution', async () => {
  const { db, repository, runtime, wire } = harness(async function* ({ purpose, messages }) {
    expect(purpose).toBe('conversation')
    expect(messages).toEqual([{ role: 'user', content: '/vocabulary legacy' }])
    yield { type: 'text', delta: 'Read-only reply' }
  })
  const module = new ConversationModule(repository, runtime, undefined, new Map(), repository)
  try {
    const sessionId = randomUUID()
    const userMessageId = randomUUID()
    await module.createPersistentConversation(sessionId, 'Existing')
    await repository.appendMessage({
      id: userMessageId,
      sessionId,
      role: 'user',
      content: '/vocabulary legacy',
      createdAt: new Date().toISOString()
    })
    await terminal((emit) =>
      module.retryMessage({ sessionId, userMessageId, requestId: randomUUID() }, emit)
    )
    expect(await repository.findExecutionByUserMessage(sessionId, userMessageId)).toBeUndefined()
    expect(
      wire.mock.calls.flatMap(([frame]) => (frame.type === 'run' ? [frame.snapshot.task] : []))
    ).toEqual(['conversation-route', 'conversation'])
  } finally {
    await module.shutdown()
    await runtime.dispose()
    db.close()
  }
})
