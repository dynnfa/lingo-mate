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
import { ExplorePhraseConversationSkill } from '../../src/core/learning/explore-phrase/explore-phrase-conversation-skill'
import {
  ExplorePhraseModule,
  type ExplorePhraseModuleOptions
} from '../../src/core/learning/explore-phrase/explore-phrase-module'
import type {
  ExplorePhraseCandidate,
  ExplorePhraseGenerator,
  ExplorePhraseGenerateInput
} from '../../src/core/learning/explore-phrase/explore-phrase-generator'
import { ExplorePhraseError } from '../../src/core/learning/explore-phrase/explore-phrase-error'
import { normalizeExplorePhrase } from '../../src/core/learning/explore-phrase/normalize-explore-phrase'
import { JsonFileExplorePhraseHistoryStore } from '../../src/main/explore-phrase-history-store'
import { createExplorePhraseFeedbackFormatter } from '../../src/main/explore-phrase-feedback'
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

function candidates(prefix: string, count: number, from = 0): ExplorePhraseCandidate[] {
  return Array.from({ length: count }, (_unused, index) => {
    const phrase = `${prefix} ${from + index}`
    return {
      phrase,
      explanation: `关于 ${phrase} 的释义`,
      example: `A natural sentence that uses ${phrase} correctly.`
    }
  })
}

// 可编程假生成器：按调用序返回预设响应，并记录请求输入。
function makeGenerator(
  responses: Array<ExplorePhraseCandidate[] | Error>,
  onGenerate?: (input: ExplorePhraseGenerateInput) => void
): ExplorePhraseGenerator {
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
  responses: Array<ExplorePhraseCandidate[] | Error>,
  options: {
    onGenerate?: (input: ExplorePhraseGenerateInput) => void
    repositoryOverride?: SqliteConversationRepository
  } = {}
): { module: ConversationModule; store: JsonFileExplorePhraseHistoryStore } {
  const conversationRepository =
    options.repositoryOverride ?? new SqliteConversationRepository(database)
  const store = new JsonFileExplorePhraseHistoryStore(historyPath)
  const exploreModule = new ExplorePhraseModule(
    store,
    () => makeGenerator(responses, options.onGenerate),
    createTestBatchRuntime(),
    undefined,
    { requestMs: 5_000, totalMs: 30_000 }
  )
  const skill = new ExplorePhraseConversationSkill(
    exploreModule,
    createExplorePhraseFeedbackFormatter()
  )
  const module = createTestConversationModule(
    unusedConversationModel,
    conversationRepository,
    () => ({ outputLanguage: 'zh-CN' as const, targetLanguage: 'en' as const }),
    new Map([[skill.skillId, skill]]),
    conversationRepository
  )
  return { module, store: store }
}

async function makeHistoryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'lingo-mate-explore-it-'))
  directories.push(directory)
  return join(directory, 'explore-phrase-history.json')
}

function exploreOptions(): Omit<ExplorePhraseModuleOptions, 'signal' | 'onPhase'> {
  return {
    executionId: randomUUID(),
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    wordLanguage: 'en',
    explanationLanguage: 'zh-CN'
  }
}

describe('explore phrase conversation integration', () => {
  it('runs the full pipeline: command message, tool candidates, JSON file, markdown table reply', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const onGenerate = vi.fn()
    const { module } = makeModule(database, historyPath, [candidates('gen', 10)], { onGenerate })
    const { sessionId } = await module.createConversation()

    const events = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )

    expect(
      events.filter((event) => event.type !== 'titleUpdated').map((event) => event.type)
    ).toEqual(['started', 'skillPhase', 'skillPhase', 'skillPhase', 'completed'])
    expect(events.at(-1)).toMatchObject({ type: 'completed', skillCompletion: 'complete' })
    expect(onGenerate).toHaveBeenCalledTimes(1)
    expect(onGenerate.mock.calls[0][0]).toMatchObject({
      count: 10,
      wordLanguage: 'en',
      explanationLanguage: 'zh-CN',
      excludedPhrases: []
    })

    const loaded = await module.loadConversation(sessionId)
    expect(loaded.messages).toHaveLength(2)
    expect(loaded.messages[0]).toMatchObject({ role: 'user', content: '/explore-phrase' })
    const reply = loaded.messages[1].content
    expect(reply.split('\n')[0]).toBe('| 序号 | 短语 | 释义 | 例句 |')
    expect(reply.split('\n')).toHaveLength(12)
    expect(reply).toContain('| 1 | gen 0 |')
    expect(reply).toContain('| 10 | gen 9 |')
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
      batches: Array<{ items: Array<{ phrase: string; normalizedPhrase: string }> }>
    }
    expect(history.schemaVersion).toBe(1)
    expect(history.batches).toHaveLength(1)
    expect(history.batches[0].items.map((item) => item.phrase)).toEqual(
      candidates('gen', 10).map((item) => item.phrase)
    )
    expect(history.batches[0].items[0].normalizedPhrase).toBe(normalizeExplorePhrase('gen 0'))
  })

  it('excludes previous batches on the next exploration and keeps the window semantics', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const onGenerate = vi.fn()
    const { module } = makeModule(database, historyPath, [candidates('second', 10)], {
      onGenerate
    })
    const { sessionId } = await module.createConversation()
    // 预置一批已提交历史（模拟上一次探索）。
    const store = new JsonFileExplorePhraseHistoryStore(historyPath)
    const previous = exploreOptions()
    await store.commit(
      {
        ...previous,
        committedAt: '2026-09-20T09:00:00.000Z',
        items: candidates('first', 10).map((candidate) => ({
          ...candidate,
          normalizedPhrase: normalizeExplorePhrase(candidate.phrase)
        }))
      },
      { base: await store.read() }
    )

    await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(onGenerate.mock.calls[0][0].excludedPhrases).toEqual(
      candidates('first', 10).map((candidate) => normalizeExplorePhrase(candidate.phrase))
    )
    const history = JSON.parse(await readFile(historyPath, 'utf8')) as {
      batches: unknown[]
    }
    expect(history.batches).toHaveLength(2)
  })

  it('tops up invalid candidates with a second request carrying the remaining count', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const first = [
      ...candidates('valid', 4),
      ...candidates('broken', 6).map((candidate) => ({
        ...candidate,
        example: 'Unrelated sentence without the phrase.'
      }))
    ]
    const onGenerate = vi.fn()
    const { module } = makeModule(database, historyPath, [first, candidates('topup', 6)], {
      onGenerate
    })
    const { sessionId } = await module.createConversation()

    const events = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(events.at(-1)).toMatchObject({ type: 'completed' })
    expect(onGenerate).toHaveBeenCalledTimes(2)
    expect(onGenerate.mock.calls[1][0].count).toBe(6)
    const loaded = await module.loadConversation(sessionId)
    const reply = loaded.messages[1].content
    expect(reply).toContain('valid 0')
    expect(reply).toContain('topup 5')
    expect(reply).not.toContain('broken 0')
  })

  it('fails clearly when three attempts cannot gather ten phrases and writes no batch', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const { module } = makeModule(database, historyPath, [
      new ExplorePhraseError('INVALID_ANALYSIS')
    ])
    const { sessionId } = await module.createConversation()

    const events = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(events.at(-1)).toMatchObject({ type: 'failed', error: { code: 'MODEL_ERROR' } })
    await expect(readFile(historyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const history = await module.loadConversation(sessionId)
    expect(history.messages).toHaveLength(1)
    // Core 不写数据库执行记录；可重试由 Renderer 对“最后一条未回复 user 消息”的投影规则补齐。
    expect(history.messages[0]).toMatchObject({ role: 'user', content: '/explore-phrase' })
  })

  it('emits a capability error for models without tool call support', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const { module } = makeModule(database, historyPath, [
      new ExplorePhraseError('TOOL_CALL_NOT_SUPPORTED')
    ])
    const { sessionId } = await module.createConversation()

    const events = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      error: { code: 'TOOL_CALL_NOT_SUPPORTED' }
    })
  })

  it('cancels during generation without writing a batch', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const hangingGenerator: ExplorePhraseGenerator = {
      generate: () => new Promise(() => {}) // 永不完成：取消路径不等待模型
    }
    const conversationRepository = new SqliteConversationRepository(database)
    const store = new JsonFileExplorePhraseHistoryStore(historyPath)
    const exploreModule = new ExplorePhraseModule(
      store,
      () => hangingGenerator,
      createTestBatchRuntime(),
      undefined,
      {
        requestMs: 5_000,
        totalMs: 30_000
      }
    )
    const skill = new ExplorePhraseConversationSkill(
      exploreModule,
      createExplorePhraseFeedbackFormatter()
    )
    const module = createTestConversationModule(
      unusedConversationModel,
      conversationRepository,
      () => ({ outputLanguage: 'zh-CN' as const, targetLanguage: 'en' as const }),
      new Map([[skill.skillId, skill]]),
      conversationRepository
    )
    const { sessionId } = await module.createConversation()

    const events: ConversationEvent[] = []
    const terminal = waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        (event) => {
          events.push(event)
          emit(event)
          if (event.type === 'skillPhase' && event.phase === 'analyzing') {
            const started = events.find((candidate) => candidate.type === 'started') as
              { requestId: string } | undefined
            if (started) module.cancelMessage(started.requestId)
          }
        }
      )
    )
    expect((await terminal).at(-1)).toMatchObject({ type: 'cancelled' })
    await expect(readFile(historyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const history = await module.loadConversation(sessionId)
    expect(history.messages).toHaveLength(1)
    // Core 不写数据库执行记录；可重试由 Renderer 对“最后一条未回复 user 消息”的投影规则补齐。
    expect(history.messages[0]).toMatchObject({ role: 'user', content: '/explore-phrase' })
  })

  it('restores the reply from the JSON batch on retry without calling the model again', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const onGenerate = vi.fn()
    const failing = new FailingAppendRepository(database)
    const { module } = makeModule(database, historyPath, [candidates('recover', 10)], {
      onGenerate,
      repositoryOverride: failing
    })
    const { sessionId } = await module.createConversation()

    const first = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(first.at(-1)).toMatchObject({ type: 'failed', error: { code: 'PERSISTENCE_ERROR' } })
    // 批次已提交：JSON 文件中有完整结果，等待重试恢复。
    const history = JSON.parse(await readFile(historyPath, 'utf8')) as {
      batches: unknown[]
    }
    expect(history.batches).toHaveLength(1)

    const conversation = await module.loadConversation(sessionId)
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
    expect(after.messages[1].content).toContain('| 序号 | 短语 | 释义 | 例句 |')
    expect(after.messages[1].content).toContain('recover 0')
    // 恢复不推进窗口：仍只有一批。
    const historyAfter = JSON.parse(await readFile(historyPath, 'utf8')) as {
      batches: unknown[]
    }
    expect(historyAfter.batches).toHaveLength(1)
  })

  it.each(['MODEL_ERROR', 'CANCELLED'] as const)(
    'retries an uncommitted %s in the same process with the original identity and language',
    async (failure) => {
      const database = openDatabase(':memory:')
      databases.push(database)
      const historyPath = await makeHistoryPath()
      const onGenerate = vi.fn()
      let fail = true
      let locale: 'zh-CN' | 'en' = 'zh-CN'
      const repository = new SqliteConversationRepository(database)
      const skill = new ExplorePhraseConversationSkill(
        new ExplorePhraseModule(
          new JsonFileExplorePhraseHistoryStore(historyPath),
          () => ({
            generate: async (input) => {
              onGenerate(input)
              if (fail) throw new ExplorePhraseError(failure)
              return candidates('retried', 10)
            }
          }),
          createTestBatchRuntime()
        ),
        createExplorePhraseFeedbackFormatter()
      )
      const module = createTestConversationModule(
        unusedConversationModel,
        repository,
        () => ({ outputLanguage: locale, targetLanguage: 'en' }),
        new Map([[skill.skillId, skill]]),
        repository
      )
      const { sessionId } = await module.createConversation()
      const first = await waitForTerminal((emit) =>
        module.runSkill(
          {
            requestId: randomUUID(),
            sessionId,
            skillId: 'explore-phrase',
            arguments: { wordLanguage: 'en' }
          },
          emit
        )
      )
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
      expect(onGenerate.mock.calls[1][0].explanationLanguage).toBe('zh-CN')
      expect((await module.loadConversation(sessionId)).messages).toHaveLength(2)
    }
  )

  it('recovers an older unreplied batch after restart and releases its eviction protection', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const onGenerate = vi.fn()
    const firstModule = makeModule(database, historyPath, [candidates('older', 10)], {
      repositoryOverride: new FailingAppendRepository(database),
      onGenerate
    }).module
    const { sessionId } = await firstModule.createConversation()
    await waitForTerminal((emit) =>
      firstModule.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    await waitForTerminal((emit) =>
      firstModule.sendMessage(
        {
          requestId: randomUUID(),
          sessionId,
          text: 'Continue chatting'
        },
        emit
      )
    )
    const restarted = makeModule(database, historyPath, [candidates('unused', 10)], {
      onGenerate
    }).module
    const loaded = await restarted.loadConversation(sessionId)
    const userMessageId = loaded.messages[0].messageId
    expect(loaded.messages[0].retryable).toBe(true)
    const restored = await waitForTerminal((emit) =>
      restarted.retryMessage(
        {
          requestId: randomUUID(),
          sessionId,
          userMessageId
        },
        emit
      )
    )
    expect(restored.at(-1)).toMatchObject({ type: 'completed' })
    expect(onGenerate).toHaveBeenCalledTimes(1)
    const again = makeModule(database, historyPath, [candidates('unused', 10)], {
      onGenerate
    }).module
    expect((await again.loadConversation(sessionId)).messages[0].retryable).not.toBe(true)
    await expect(
      again.retryMessage({ requestId: randomUUID(), sessionId, userMessageId }, () => {})
    ).rejects.toBeInstanceOf(RetryNotAllowedError)
    // The recovered batch must be evictable even though its reply was appended later.
    for (let i = 0; i < 7; i += 1) {
      const next = makeModule(database, historyPath, [candidates(`next ${i}`, 10)]).module
      const fresh = await next.createConversation()
      const events = await waitForTerminal((emit) =>
        next.runSkill(
          {
            requestId: randomUUID(),
            sessionId: fresh.sessionId,
            skillId: 'explore-phrase',
            arguments: { wordLanguage: 'en' }
          },
          emit
        )
      )
      expect(events.at(-1)).toMatchObject({ type: 'completed' })
    }
    const store = new JsonFileExplorePhraseHistoryStore(historyPath)
    expect(await store.findBatchByUserMessage(userMessageId)).toBeUndefined()
    await expect(
      again.retryMessage({ requestId: randomUUID(), sessionId, userMessageId }, () => {})
    ).rejects.toBeInstanceOf(RetryNotAllowedError)
  })

  it('retries a confirmed pre-replacement storage failure in the same process', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const { module, store } = makeModule(database, historyPath, [candidates('retry storage', 10)])
    vi.spyOn(store, 'commit').mockRejectedValueOnce(new ExplorePhraseError('STORAGE_FAILED'))
    const { sessionId } = await module.createConversation()
    const first = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(first.at(-1)).toMatchObject({ type: 'failed' })
    const started = first.find((event) => event.type === 'started')!
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
    expect((await store.read()).batches).toHaveLength(1)
  })

  it('does not regenerate an uncertain commit whose batch is missing', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const onGenerate = vi.fn()
    const { module, store } = makeModule(database, historyPath, [candidates('uncertain', 10)], {
      onGenerate
    })
    vi.spyOn(store, 'commit').mockRejectedValueOnce(new ExplorePhraseError('COMMIT_UNCERTAIN'))
    const { sessionId } = await module.createConversation()
    const first = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(first.at(-1)).toMatchObject({ type: 'failed', error: { code: 'PERSISTENCE_ERROR' } })
    const started = first.find((event) => event.type === 'started')!
    await expect(
      module.retryMessage(
        { requestId: randomUUID(), sessionId, userMessageId: started.userMessage.messageId },
        () => {}
      )
    ).rejects.toBeInstanceOf(RetryNotAllowedError)
    expect(onGenerate).toHaveBeenCalledOnce()
  })

  it('does not treat a recovered older reply as the answer to the adjacent unanswered command', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const repository = new FailingAppendRepository(database, 2)
    const first = makeModule(database, historyPath, [candidates('one', 10)], {
      repositoryOverride: repository
    }).module
    const { sessionId } = await first.createConversation()
    await waitForTerminal((emit) =>
      first.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    const second = makeModule(database, historyPath, [candidates('two', 10)], {
      repositoryOverride: repository
    }).module
    await waitForTerminal((emit) =>
      second.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    const users = (await second.loadConversation(sessionId)).messages
    await waitForTerminal((emit) =>
      second.retryMessage(
        { requestId: randomUUID(), sessionId, userMessageId: users[0].messageId },
        emit
      )
    )
    const loaded = await second.loadConversation(sessionId)
    expect(loaded.messages[1].retryable).toBe(true)
    const restored = await waitForTerminal((emit) =>
      second.retryMessage(
        { requestId: randomUUID(), sessionId, userMessageId: users[1].messageId },
        emit
      )
    )
    expect(restored.at(-1)).toMatchObject({ type: 'completed' })
    expect(
      (await second.loadConversation(sessionId)).messages.filter(
        (message) => message.role === 'assistant'
      )
    ).toHaveLength(2)
  })

  it('recognizes a legacy random-ID reply even when its batch is no longer in the history file', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const repository = new SqliteConversationRepository(database)
    const sessionId = randomUUID()
    const userMessageId = randomUUID()
    const at = '2026-09-20T09:00:00.000Z'
    await repository.appendMessage(
      { id: userMessageId, sessionId, role: 'user', content: '/explore-phrase', createdAt: at },
      { id: sessionId, title: 'Legacy', createdAt: at, updatedAt: at }
    )
    await repository.appendMessage({
      id: randomUUID(),
      sessionId,
      role: 'assistant',
      content: '| Legacy table |',
      createdAt: at
    })
    const onGenerate = vi.fn()
    const { module } = makeModule(database, await makeHistoryPath(), [], { onGenerate })
    expect((await module.loadConversation(sessionId)).messages[0].retryable).not.toBe(true)
    await expect(
      module.retryMessage({ requestId: randomUUID(), sessionId, userMessageId }, () => {})
    ).rejects.toBeInstanceOf(RetryNotAllowedError)
    expect(onGenerate).not.toHaveBeenCalled()
  })

  it('reports completion when cancelled after the batch has committed', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const { module } = makeModule(database, await makeHistoryPath(), [candidates('saved', 10)])
    const { sessionId } = await module.createConversation()
    const requestId = randomUUID()
    const events = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId,
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        (event) => {
          if (event.type === 'skillPhase' && event.phase === 'summarizing')
            module.cancelMessage(requestId)
          emit(event)
        }
      )
    )
    expect(events.at(-1)).toMatchObject({ type: 'completed' })
    expect((await module.loadConversation(sessionId)).messages).toHaveLength(2)
  })

  it('rejects retry after restart when the batch is not recoverable instead of regenerating', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const onGenerate = vi.fn()
    const { module } = makeModule(
      database,
      historyPath,
      [new ExplorePhraseError('INVALID_ANALYSIS')],
      { onGenerate }
    )
    const { sessionId } = await module.createConversation()
    const first = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(first.at(-1)).toMatchObject({ type: 'failed' })

    const conversation = await module.loadConversation(sessionId)
    const restarted = makeModule(database, historyPath, [candidates('must not generate', 10)], {
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

  it('refuses to evict an unreplied batch and surfaces a persistence error', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const historyPath = await makeHistoryPath()
    const store = new JsonFileExplorePhraseHistoryStore(historyPath)
    // 历史会话：一条未回复的 /explore-phrase 消息（第一批挂在它上面）。
    const conversationRepository = new SqliteConversationRepository(database)
    const seededSessionId = randomUUID()
    const seededAt = '2026-09-20T09:00:00.000Z'
    const userMessage: StoredMessage = {
      id: randomUUID(),
      sessionId: seededSessionId,
      role: 'user',
      content: '/explore-phrase',
      createdAt: seededAt
    }
    await conversationRepository.appendMessage(userMessage, {
      id: seededSessionId,
      title: '/explore-phrase',
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
          committedAt: `2026-09-20T09:0${index}:00.000Z`,
          ...options,
          items: candidates(`seed${index}`, 10).map((candidate) => ({
            ...candidate,
            normalizedPhrase: normalizeExplorePhrase(candidate.phrase)
          }))
        },
        { base: await store.read() }
      )
    }

    const onGenerate = vi.fn()
    const { module } = makeModule(database, historyPath, [candidates('overflow', 10)], {
      onGenerate,
      repositoryOverride: conversationRepository
    })
    const { sessionId: freshSession } = await module.createConversation()
    const events = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId: freshSession,
          skillId: 'explore-phrase',
          arguments: { wordLanguage: 'en' }
        },
        emit
      )
    )
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
