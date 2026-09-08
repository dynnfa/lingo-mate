import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationEvent } from '../../src/shared/conversation'
import type { LanguageModel } from '../../src/core/llm/language-model'
import { ConversationModule } from '../../src/core/conversation/conversation-module'
import { PhraseConversationSkill } from '../../src/core/learning/phrase/phrase-conversation-skill'
import type { PhraseAnalyzer } from '../../src/core/learning/phrase/phrase-analyzer'
import { insertResult } from '../../src/core/learning/phrase/__tests__/fixtures'
import { createPhraseFeedbackFormatter } from '../../src/main/phrase-feedback'
import { openDatabase } from '../../src/database/database'
import {
  SqliteConversationRepository,
  type StoredMessage
} from '../../src/database/sqlite-conversation-repository'
import { SqlitePhraseRepository } from '../../src/database/sqlite-phrase-repository'
import type Database from 'better-sqlite3'

const databases: Database.Database[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const unusedConversationModel: LanguageModel = {
  async *streamReply() {
    yield 'unused'
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

function makeModule(
  database: Database.Database,
  analyze: PhraseAnalyzer['analyze'],
  repositoryOverride?: SqliteConversationRepository
): {
  module: ConversationModule
  phraseRepository: SqlitePhraseRepository
} {
  const conversationRepository = repositoryOverride ?? new SqliteConversationRepository(database)
  const phraseRepository = new SqlitePhraseRepository(database)
  const skill = new PhraseConversationSkill(
    phraseRepository,
    () => ({ analyze }),
    createPhraseFeedbackFormatter()
  )
  const module = new ConversationModule(
    unusedConversationModel,
    conversationRepository,
    () => ({ outputLanguage: 'en' as const, targetLanguage: 'en' as const }),
    new Map([[skill.skillId, skill]]),
    conversationRepository
  )
  return { module, phraseRepository }
}

describe('phrase conversation integration', () => {
  it('persists the invocation, actual batch, and localized assistant reply without a second model call', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const analyze = vi.fn(async ({ phrase }: { phrase: string }) => insertResult(phrase))
    const { module, phraseRepository } = makeModule(database, analyze)
    const { sessionId } = await module.createConversation()

    const events = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'phrase',
          arguments: {
            text: 'look forward to\nif anything, at all\nlook forward to',
            wordLanguage: 'en'
          }
        },
        emit
      )
    )

    expect(
      events.filter((event) => event.type !== 'titleUpdated').map((event) => event.type)
    ).toEqual(['started', 'skillPhase', 'skillPhase', 'skillPhase', 'completed'])
    const completed = events.at(-1)
    expect(completed).toMatchObject({ type: 'completed', skillCompletion: 'complete' })
    // 恰好新增两行、各三个字段；重复项不再请求模型
    const rows = database
      .prepare('SELECT phrase, explantation, example FROM phrase ORDER BY phrase')
      .all() as Array<{ phrase: string; explantation: string; example: string }>
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.phrase)).toEqual(['if anything, at all', 'look forward to'])
    for (const row of rows) {
      expect(row.explantation).toBeTruthy()
      expect(row.example).toBeTruthy()
    }
    expect(analyze).toHaveBeenCalledTimes(2)

    const loaded = await module.loadConversation(sessionId)
    expect(loaded.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(loaded.messages[0].content).toBe(
      '/phrase look forward to\nif anything, at all\nlook forward to'
    )
    expect(loaded.messages[1].content).toContain('2 added')
    expect(loaded.messages[1].content).toContain('1 repeated')
    expect(loaded.messages[1].retryable).toBeUndefined()

    const conversationRepository = new SqliteConversationRepository(database)
    const execution = await conversationRepository.findExecutionByUserMessage(
      sessionId,
      loaded.messages[0].messageId
    )
    expect(execution).toMatchObject({ skillId: 'phrase', phase: 'completed' })
    expect(execution?.batch?.counts).toMatchObject({ saved: 2, duplicate: 1 })

    // 再次提交同一短语：全部已存在，零模型请求
    const second = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'phrase',
          arguments: { text: 'look forward to', wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(second.at(-1)).toMatchObject({ type: 'completed' })
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(phraseRepository.findExisting(['look forward to']).has('look forward to')).toBe(true)
    expect(
      (database.prepare('SELECT COUNT(*) AS count FROM phrase').get() as { count: number }).count
    ).toBe(2)
  })
  it('regenerates the local reply on retry without calling the model again', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const analyze = vi.fn(async () => insertResult())
    const failing = new FailingFinishRepository(database)
    const { module } = makeModule(database, analyze, failing)
    const { sessionId } = await module.createConversation()

    const first = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'phrase',
          arguments: { text: 'look forward to', wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(first.at(-1)).toMatchObject({ type: 'failed', error: { code: 'PERSISTENCE_ERROR' } })
    const history = await module.loadConversation(sessionId)
    expect(history.messages[0].retryable).toBe(true)
    // 短语已提交：报告存在，重试不得再次写库或调用模型。
    expect(
      (database.prepare('SELECT COUNT(*) AS count FROM phrase').get() as { count: number }).count
    ).toBe(1)
    expect(analyze).toHaveBeenCalledTimes(1)

    const retry = await waitForTerminal((emit) =>
      module.retryMessage(
        {
          requestId: randomUUID(),
          sessionId,
          userMessageId: history.messages[0].messageId
        },
        emit
      )
    )
    expect(retry.at(-1)).toMatchObject({ type: 'completed', skillCompletion: 'complete' })
    expect(analyze).toHaveBeenCalledTimes(1)
    const afterRetry = await module.loadConversation(sessionId)
    expect(afterRetry.messages.at(-1)?.content).toContain('1 added')
    expect(afterRetry.messages.at(-1)?.content).toContain('look forward to')
    expect(afterRetry.messages[0].retryable).toBeUndefined()
    expect(afterRetry.messages).toHaveLength(2)
  })
  it('marks a user-cancelled batch cancelled without writing pending phrases', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const analyze = vi.fn(
      () => new Promise(() => {}) // 永不完成：取消路径不等待模型
    )
    const { module } = makeModule(database, analyze)
    const { sessionId } = await module.createConversation()

    const events: ConversationEvent[] = []
    const terminal = waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'phrase',
          arguments: { text: 'look forward to', wordLanguage: 'en' }
        },
        (event) => {
          events.push(event)
          emit(event)
          if (event.type === 'skillPhase' && event.phase === 'analyzing') {
            module.cancelMessage(
              (events.find((candidate) => candidate.type === 'started') as { requestId: string })
                .requestId
            )
          }
        }
      )
    )
    expect((await terminal).at(-1)).toMatchObject({ type: 'cancelled' })
    expect(
      (database.prepare('SELECT COUNT(*) AS count FROM phrase').get() as { count: number }).count
    ).toBe(0)
    const conversationRepository = new SqliteConversationRepository(database)
    const history = await module.loadConversation(sessionId)
    const execution = await conversationRepository.findExecutionByUserMessage(
      sessionId,
      history.messages[0].messageId
    )
    expect(execution).toMatchObject({ skillId: 'phrase', phase: 'cancelled' })
    expect(execution?.batch).toBeUndefined()
  })
  it('emits a retryable capability error without persisting a failed batch or assistant reply', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const analyze = vi.fn(async () => {
      const { PhraseError } = await import('../../src/core/learning/phrase/parse-phrase-input')
      throw new PhraseError('TOOL_CALL_NOT_SUPPORTED')
    })
    const { module } = makeModule(database, analyze)
    const { sessionId } = await module.createConversation()

    const events = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'phrase',
          arguments: { text: 'look forward to', wordLanguage: 'en' }
        },
        emit
      )
    )

    expect(
      events.filter((event) => event.type !== 'titleUpdated').map((event) => event.type)
    ).toEqual(['started', 'skillPhase', 'failed'])
    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      error: { code: 'TOOL_CALL_NOT_SUPPORTED' }
    })
    expect(
      (database.prepare('SELECT COUNT(*) AS count FROM phrase').get() as { count: number }).count
    ).toBe(0)
    const history = await module.loadConversation(sessionId)
    expect(history.messages).toHaveLength(1)
    expect(history.messages[0]).toMatchObject({ role: 'user', retryable: true })
  })
})

// 第一次 finishExecution 失败：模拟短语已提交但 assistant 消息尚未保存时退出应用。
class FailingFinishRepository extends SqliteConversationRepository {
  private failuresLeft = 1
  override async finishExecution(
    executionId: string,
    phase: 'completed' | 'description_failed' | 'description_cancelled',
    assistantMessage: StoredMessage
  ): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1
      throw new Error('fixture: assistant message persistence failed')
    }
    return super.finishExecution(executionId, phase, assistantMessage)
  }
}
