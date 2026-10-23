import { createTestBatchRuntime } from '../fixtures/python-agent'
import { createTestConversationModule } from '../fixtures/conversation'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationEvent } from '../../src/shared/conversation'
import type { LanguageModel } from '../../src/core/llm/language-model'
import type { ConversationModule } from '../../src/core/conversation/conversation-module'
import { ExploreVocabularyConversationSkill } from '../../src/core/learning/explore-vocabulary/explore-vocabulary-conversation-skill'
import {
  ExploreVocabularyModule,
  type ExploreVocabularyModuleOptions
} from '../../src/core/learning/explore-vocabulary/explore-vocabulary-module'
import type {
  ExploreVocabularyCandidate,
  ExploreVocabularyGenerator,
  ExploreVocabularyGenerateInput
} from '../../src/core/learning/explore-vocabulary/explore-vocabulary-generator'
import { ExploreVocabularyError } from '../../src/core/learning/explore-vocabulary/explore-vocabulary-error'
import { normalizeExploreVocabularyTerm } from '../../src/core/learning/explore-vocabulary/normalize-explore-vocabulary'
import { JsonFileExploreVocabularyHistoryStore } from '../../src/main/explore-vocabulary-history-store'
import { createExploreVocabularyFeedbackFormatter } from '../../src/main/explore-vocabulary-feedback'
import { JsonFileExplorePhraseHistoryStore } from '../../src/main/explore-phrase-history-store'
import { createExplorePhraseFeedbackFormatter } from '../../src/main/explore-phrase-feedback'
import { ExplorePhraseConversationSkill } from '../../src/core/learning/explore-phrase/explore-phrase-conversation-skill'
import { ExplorePhraseModule } from '../../src/core/learning/explore-phrase/explore-phrase-module'
import type {
  ExplorePhraseCandidate,
  ExplorePhraseGenerator
} from '../../src/core/learning/explore-phrase/explore-phrase-generator'
import { openDatabase } from '../../src/database/database'
import {
  SqliteConversationRepository,
  type StoredMessage
} from '../../src/database/sqlite-conversation-repository'
import type Database from 'better-sqlite3'
import { RetryNotAllowedError } from '../../src/core/conversation/conversation-repository'

const databases: Database.Database[] = []
const directories: string[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true })
  }
})

const unusedConversationModel: LanguageModel = {
  async *streamReply() {
    yield { type: 'text' as const, delta: 'unused' }
  }
}

function waitForTerminal(
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

// 无数字词表：词条词形规则拒绝含数字的候选。
const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet'
]

function wordCandidates(prefix: string, count: number, from = 0): ExploreVocabularyCandidate[] {
  return Array.from({ length: count }, (_unused, index) => {
    const term = `${prefix}${WORDS[from + index]}`
    return {
      term,
      explanation: `关于 ${term} 的释义`,
      example: `A natural sentence that uses ${term} correctly.`
    }
  })
}

// 可编程假生成器：按调用序返回预设响应，并记录请求输入。
function makeGenerator(
  responses: Array<ExploreVocabularyCandidate[] | Error>,
  onGenerate?: (input: ExploreVocabularyGenerateInput) => void
): ExploreVocabularyGenerator {
  let call = 0
  return {
    async generate(input) {
      onGenerate?.(input)
      const response = responses[Math.min(call, responses.length - 1)]
      call += 1
      if (response instanceof Error) throw response
      return response
    }
  }
}

function makeModule(
  database: Database.Database,
  historyPath: string,
  responses: Array<ExploreVocabularyCandidate[] | Error>,
  options: {
    onGenerate?: (input: ExploreVocabularyGenerateInput) => void
    repositoryOverride?: SqliteConversationRepository
  } = {}
): { module: ConversationModule; store: JsonFileExploreVocabularyHistoryStore } {
  const conversationRepository =
    options.repositoryOverride ?? new SqliteConversationRepository(database)
  const store = new JsonFileExploreVocabularyHistoryStore(historyPath)
  const skill = new ExploreVocabularyConversationSkill(
    new ExploreVocabularyModule(
      store,
      () => makeGenerator(responses, options.onGenerate),
      undefined,
      {
        requestMs: 5_000,
        totalMs: 30_000
      }
    ),
    createExploreVocabularyFeedbackFormatter()
  )
  const module = createTestConversationModule(
    unusedConversationModel,
    conversationRepository,
    () => ({ outputLanguage: 'zh-CN' as const, targetLanguage: 'en' as const }),
    new Map([[skill.skillId, skill]]),
    conversationRepository
  )
  return { module, store }
}

async function makeHistoryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'lingo-mate-explore-vocab-it-'))
  directories.push(directory)
  return join(directory, 'explore-vocabulary-history.json')
}

function exploreOptions(): Omit<ExploreVocabularyModuleOptions, 'signal' | 'onPhase'> {
  return {
    executionId: randomUUID(),
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    wordLanguage: 'en',
    explanationLanguage: 'zh-CN'
  }
}

const runVocabulary = (
  module: ConversationModule,
  sessionId: string,
  emit: (event: ConversationEvent) => void
): Promise<unknown> =>
  module.runSkill(
    {
      requestId: randomUUID(),
      sessionId,
      skillId: 'explore-vocabulary',
      arguments: { wordLanguage: 'en' }
    },
    emit
  )

describe('explore vocabulary conversation integration', () => {
  it('runs the full pipeline: command message, tool candidates, JSON file, markdown table reply', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const onGenerate = vi.fn()
    const { module } = makeModule(database, historyPath, [wordCandidates('gen', 10)], {
      onGenerate
    })
    const { sessionId } = await module.createConversation()

    const events = await waitForTerminal((emit) => runVocabulary(module, sessionId, emit))

    expect(
      events.filter((event) => event.type !== 'titleUpdated').map((event) => event.type)
    ).toEqual(['started', 'skillPhase', 'skillPhase', 'skillPhase', 'completed'])
    expect(events.at(-1)).toMatchObject({ type: 'completed', skillCompletion: 'complete' })
    expect(onGenerate).toHaveBeenCalledTimes(1)
    expect(onGenerate.mock.calls[0][0]).toMatchObject({
      count: 10,
      wordLanguage: 'en',
      explanationLanguage: 'zh-CN',
      excludedTerms: []
    })

    const loaded = await module.loadConversation(sessionId)
    expect(loaded.messages).toHaveLength(2)
    expect(loaded.messages[0]).toMatchObject({ role: 'user', content: '/explore-vocabulary' })
    const reply = loaded.messages[1].content
    expect(reply.split('\n')[0]).toBe('| 序号 | 单词 | 释义 | 例句 |')
    expect(reply.split('\n')).toHaveLength(12)
    expect(reply).toContain('| 1 | genalpha |')
    expect(reply).toContain('| 10 | genjuliet |')
    expect(loaded.messages[1].retryable).toBeUndefined()

    // 结果只写入 JSON 历史文件，不产生数据库技能执行记录。
    const conversationRepository = new SqliteConversationRepository(database)
    expect(
      await conversationRepository.findExecutionByUserMessage(
        sessionId,
        loaded.messages[0].messageId
      )
    ).toBeUndefined()
    const history = JSON.parse(await readFile(historyPath, 'utf8')) as {
      schemaVersion: number
      batches: Array<{ items: Array<{ term: string; normalizedTerm: string }> }>
    }
    expect(history.schemaVersion).toBe(1)
    expect(history.batches).toHaveLength(1)
    expect(history.batches[0].items.map((item) => item.term)).toEqual(
      wordCandidates('gen', 10).map((item) => item.term)
    )
    expect(history.batches[0].items[0].normalizedTerm).toBe(
      normalizeExploreVocabularyTerm('genalpha')
    )
  })

  it('keeps phrase and vocabulary histories, windows and identities isolated', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const directory = await mkdtemp(join(tmpdir(), 'lingo-mate-explore-mixed-it-'))
    directories.push(directory)
    const vocabularyPath = join(directory, 'explore-vocabulary-history.json')
    const phrasePath = join(directory, 'explore-phrase-history.json')

    const vocabularyGenerate = vi.fn()
    const phraseGenerate = vi.fn()
    const phraseGenerator: ExplorePhraseGenerator = {
      async generate(input) {
        phraseGenerate(input)
        return Array.from({ length: 10 }, (_unused, index) => {
          const phrase = `mixed phrase ${index}`
          const candidate: ExplorePhraseCandidate = {
            phrase,
            explanation: `关于 ${phrase} 的释义`,
            example: `A sentence with ${phrase} inside.`
          }
          return candidate
        })
      }
    }
    const vocabularySkill = new ExploreVocabularyConversationSkill(
      new ExploreVocabularyModule(new JsonFileExploreVocabularyHistoryStore(vocabularyPath), () =>
        makeGenerator([wordCandidates('vocab', 10)], vocabularyGenerate)
      ),
      createExploreVocabularyFeedbackFormatter()
    )
    const phraseSkill = new ExplorePhraseConversationSkill(
      new ExplorePhraseModule(
        new JsonFileExplorePhraseHistoryStore(phrasePath),
        () => phraseGenerator,
        createTestBatchRuntime()
      ),
      createExplorePhraseFeedbackFormatter()
    )
    const repository = new SqliteConversationRepository(database)
    const module = createTestConversationModule(
      unusedConversationModel,
      repository,
      () => ({ outputLanguage: 'zh-CN' as const, targetLanguage: 'en' as const }),
      new Map([
        [vocabularySkill.skillId, vocabularySkill],
        [phraseSkill.skillId, phraseSkill]
      ]),
      repository
    )
    const { sessionId } = await module.createConversation()

    // 先运行词汇探索。
    const vocabularyEvents = await waitForTerminal((emit) => runVocabulary(module, sessionId, emit))
    expect(vocabularyEvents.at(-1)).toMatchObject({ type: 'completed' })
    // 同一会话需等前一个请求结束，第二个技能在新会话运行。
    const second = await module.createConversation()
    const phraseEvents = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId: second.sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(phraseEvents.at(-1)).toMatchObject({ type: 'completed' })

    // 各自的历史文件独立存在；词汇批次不写入短语文件，反之亦然。
    const vocabularyHistory = JSON.parse(await readFile(vocabularyPath, 'utf8')) as {
      batches: Array<{ items: Array<{ term: string }> }>
    }
    const phraseHistory = JSON.parse(await readFile(phrasePath, 'utf8')) as {
      batches: Array<{ items: Array<{ phrase: string }> }>
    }
    expect(vocabularyHistory.batches).toHaveLength(1)
    expect(phraseHistory.batches).toHaveLength(1)
    expect(vocabularyHistory.batches[0].items[0].term).toBe('vocabalpha')
    expect(phraseHistory.batches[0].items[0].phrase).toContain(' ')
  })

  it('restores the reply from the JSON batch on retry without calling the model again', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const onGenerate = vi.fn()
    const failing = new FailingAppendRepository(database)
    const { module } = makeModule(database, historyPath, [wordCandidates('recover', 10)], {
      onGenerate,
      repositoryOverride: failing
    })
    const { sessionId } = await module.createConversation()

    const first = await waitForTerminal((emit) => runVocabulary(module, sessionId, emit))
    expect(first.at(-1)).toMatchObject({ type: 'failed', error: { code: 'PERSISTENCE_ERROR' } })
    // 批次已提交：JSON 文件中有完整结果，等待重试恢复。
    const history = JSON.parse(await readFile(historyPath, 'utf8')) as { batches: unknown[] }
    expect(history.batches).toHaveLength(1)

    const conversation = await module.loadConversation(sessionId)
    expect(conversation.messages[0].retryable).toBe(true)
    const retry = await waitForTerminal((emit) =>
      module.retryMessage(
        { requestId: randomUUID(), sessionId, userMessageId: conversation.messages[0].messageId },
        emit
      )
    )
    expect(retry.at(-1)).toMatchObject({ type: 'completed', skillCompletion: 'complete' })
    expect(onGenerate).toHaveBeenCalledTimes(1)
    const after = await module.loadConversation(sessionId)
    expect(after.messages).toHaveLength(2)
    expect(after.messages[1].content).toContain('| 序号 | 单词 | 释义 | 例句 |')
    expect(after.messages[1].content).toContain('recoveralpha')
    // 恢复不推进窗口：仍只有一批。
    const historyAfter = JSON.parse(await readFile(historyPath, 'utf8')) as { batches: unknown[] }
    expect(historyAfter.batches).toHaveLength(1)
  })

  it.each(['MODEL_ERROR', 'CANCELLED'] as const)(
    'retries an uncommitted vocabulary %s as the vocabulary skill with the original identity and language',
    async (failure) => {
      const database = openDatabase(':memory:')
      databases.push(database)
      const historyPath = await makeHistoryPath()
      const onGenerate = vi.fn()
      let fail = true
      let locale: 'zh-CN' | 'en' = 'zh-CN'
      const repository = new SqliteConversationRepository(database)
      const skill = new ExploreVocabularyConversationSkill(
        new ExploreVocabularyModule(new JsonFileExploreVocabularyHistoryStore(historyPath), () => ({
          generate: async (input) => {
            onGenerate(input)
            if (fail) throw new ExploreVocabularyError(failure)
            return wordCandidates('retried', 10)
          }
        })),
        createExploreVocabularyFeedbackFormatter()
      )
      const module = createTestConversationModule(
        unusedConversationModel,
        repository,
        () => ({ outputLanguage: locale, targetLanguage: 'en' }),
        new Map([[skill.skillId, skill]]),
        repository
      )
      const { sessionId } = await module.createConversation()
      const first = await waitForTerminal((emit) => runVocabulary(module, sessionId, emit))
      expect(first.at(-1)).toMatchObject({ type: failure === 'CANCELLED' ? 'cancelled' : 'failed' })
      const started = first.find((event) => event.type === 'started')!
      fail = false
      locale = 'en'
      const retry = await waitForTerminal((emit) =>
        module.retryMessage(
          {
            requestId: randomUUID(),
            sessionId,
            userMessageId: started.userMessage.messageId
          },
          emit
        )
      )
      expect(retry.at(-1)).toMatchObject({ type: 'completed' })
      expect(retry.find((event) => event.type === 'started')).toMatchObject({
        assistantMessageId: started.assistantMessageId,
        userMessage: { messageId: started.userMessage.messageId }
      })
      // 解释语言快照来自首次执行，不读取当前设置。
      expect(onGenerate.mock.calls[1][0].explanationLanguage).toBe('zh-CN')
      expect((await module.loadConversation(sessionId)).messages).toHaveLength(2)
    }
  )

  it('rejects retry after restart when the vocabulary batch is not recoverable', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const onGenerate = vi.fn()
    const { module } = makeModule(
      database,
      historyPath,
      [new ExploreVocabularyError('INVALID_ANALYSIS')],
      { onGenerate }
    )
    const { sessionId } = await module.createConversation()
    const first = await waitForTerminal((emit) => runVocabulary(module, sessionId, emit))
    expect(first.at(-1)).toMatchObject({ type: 'failed' })

    const conversation = await module.loadConversation(sessionId)
    const restarted = makeModule(database, historyPath, [wordCandidates('mustnot', 10)], {
      onGenerate
    }).module
    await expect(
      restarted.retryMessage(
        { requestId: randomUUID(), sessionId, userMessageId: conversation.messages[0].messageId },
        () => undefined
      )
    ).rejects.toBeInstanceOf(RetryNotAllowedError)
    // 重试不做恢复也不重新生成：模型调用仍是首次执行的 3 次。
    expect(onGenerate).toHaveBeenCalledTimes(3)
  })

  it('refuses to evict an unreplied vocabulary batch and surfaces a persistence error', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const store = new JsonFileExploreVocabularyHistoryStore(historyPath)
    // 历史会话：一条未回复的 /explore-vocabulary 消息（第一批挂在它上面）。
    const conversationRepository = new SqliteConversationRepository(database)
    const seededSessionId = randomUUID()
    const seededAt = '2026-09-21T09:00:00.000Z'
    const userMessage: StoredMessage = {
      id: randomUUID(),
      sessionId: seededSessionId,
      role: 'user',
      content: '/explore-vocabulary',
      createdAt: seededAt
    }
    await conversationRepository.appendMessage(userMessage, {
      id: seededSessionId,
      title: '/explore-vocabulary',
      createdAt: seededAt,
      updatedAt: seededAt
    })
    // 预置 7 批：第一批挂在未回复消息上，其余为普通历史。
    for (let index = 0; index < 7; index += 1) {
      const options =
        index === 0
          ? { executionId: randomUUID(), sessionId: seededSessionId, userMessageId: userMessage.id }
          : exploreOptions()
      await store.commit(
        {
          wordLanguage: 'en',
          explanationLanguage: 'zh-CN',
          committedAt: `2026-09-21T09:0${index}:00.000Z`,
          ...options,
          items: wordCandidates(`seed${index}`, 10).map((candidate) => ({
            ...candidate,
            normalizedTerm: normalizeExploreVocabularyTerm(candidate.term)
          }))
        },
        { base: await store.read() }
      )
    }

    const onGenerate = vi.fn()
    const { module } = makeModule(database, historyPath, [wordCandidates('overflow', 10)], {
      onGenerate,
      repositoryOverride: conversationRepository
    })
    const { sessionId: freshSession } = await module.createConversation()
    const events = await waitForTerminal((emit) => runVocabulary(module, freshSession, emit))
    expect(events.at(-1)).toMatchObject({ type: 'failed', error: { code: 'PERSISTENCE_ERROR' } })
    // 未回复的第一批仍在文件中，未被淘汰。
    const history = JSON.parse(await readFile(historyPath, 'utf8')) as {
      batches: Array<{ userMessageId: string }>
    }
    expect(history.batches).toHaveLength(7)
    expect(history.batches.some((batch) => batch.userMessageId === userMessage.id)).toBe(true)
  })
})

// 第一次 appendMessage(assistant) 失败：模拟批次已提交但回复未保存时退出应用。
class FailingAppendRepository extends SqliteConversationRepository {
  constructor(
    database: Database.Database,
    private failuresLeft = 1
  ) {
    super(database)
  }
  override async appendMessage(
    message: StoredMessage,
    conversation?: Parameters<SqliteConversationRepository['appendMessage']>[1]
  ): Promise<void> {
    if (this.failuresLeft > 0 && message.role === 'assistant') {
      this.failuresLeft -= 1
      throw new Error('fixture: assistant message persistence failed')
    }
    return super.appendMessage(message, conversation)
  }
}
