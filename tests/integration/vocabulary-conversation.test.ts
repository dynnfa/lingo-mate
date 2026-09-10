import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationEvent } from '../../src/shared/conversation'
import type { LanguageModel } from '../../src/core/llm/language-model'
import {
  ConversationModule,
  SkillLanguageMismatchError,
  type ConversationLanguages
} from '../../src/core/conversation/conversation-module'
import { VocabularyConversationSkill } from '../../src/core/learning/vocabulary/vocabulary-conversation-skill'
import type { VocabularyAnalyzer } from '../../src/core/learning/vocabulary/vocabulary-analyzer'
import { VocabularyError } from '../../src/core/learning/vocabulary/parse-vocabulary-input'
import { insertResult } from '../../src/core/learning/vocabulary/__tests__/fixtures'
import { createVocabularyFeedbackFormatter } from '../../src/main/vocabulary-feedback'
import { openDatabase } from '../../src/database/database'
import {
  SqliteConversationRepository,
  type StoredMessage
} from '../../src/database/sqlite-conversation-repository'
import { SqliteVocabularyRepository } from '../../src/database/sqlite-vocabulary-repository'
import type Database from 'better-sqlite3'

const databases: Database.Database[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
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

function makeSkill(
  repository: SqliteVocabularyRepository,
  analyze: VocabularyAnalyzer['analyze']
): VocabularyConversationSkill {
  return new VocabularyConversationSkill(
    repository,
    () => ({ analyzer: { analyze } }),
    createVocabularyFeedbackFormatter()
  )
}

describe('vocabulary conversation integration', () => {
  it('persists the invocation, actual batch, and localized assistant reply without a second model call', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const conversationRepository = new SqliteConversationRepository(database)
    const vocabularyRepository = new SqliteVocabularyRepository(database)
    const analyze = vi.fn(async ({ term }: { term: string }) => insertResult(term))
    const skill = makeSkill(vocabularyRepository, analyze)
    const module = new ConversationModule(
      unusedConversationModel,
      conversationRepository,
      () => ({ outputLanguage: 'en' as const, targetLanguage: 'en' as const }),
      new Map([[skill.skillId, skill]]),
      conversationRepository
    )
    const { sessionId } = await module.createConversation()

    const events = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'vocabulary',
          arguments: { text: 'apple, banana, apple', wordLanguage: 'en' }
        },
        emit
      )
    )

    expect(
      events.filter((event) => event.type !== 'titleUpdated').map((event) => event.type)
    ).toEqual(['started', 'skillPhase', 'skillPhase', 'skillPhase', 'completed'])
    const completed = events.at(-1)
    expect(completed).toMatchObject({ type: 'completed', skillCompletion: 'complete' })
    expect(vocabularyRepository.list({}).entries).toHaveLength(2)
    const loaded = await module.loadConversation(sessionId)
    expect(loaded.conversation.title).toBe('unused')
    expect(loaded.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(loaded.messages[0].content).toBe('/vocabulary apple, banana, apple')
    expect(loaded.messages[1].content).toContain('2 added')
    expect(loaded.messages[1].content).toContain('apple and banana')
    expect(loaded.messages[1].content).toContain('1 repeated')
    expect(loaded.messages[1].retryable).toBeUndefined()

    const execution = await conversationRepository.findExecutionByUserMessage(
      sessionId,
      loaded.messages[0].messageId
    )
    expect(execution?.phase).toBe('completed')
    if (execution?.skillId !== 'vocabulary') throw new Error('Unexpected skill report')
    expect(execution.batch?.counts).toMatchObject({ saved: 2, duplicate: 1 })
    expect(analyze).toHaveBeenCalledTimes(2)
  })

  it('regenerates the local reply on retry without calling the model again', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const conversationRepository = new FailingFinishRepository(database)
    const vocabularyRepository = new SqliteVocabularyRepository(database)
    const analyze = vi.fn(async () => insertResult())
    const skill = makeSkill(vocabularyRepository, analyze)
    const module = new ConversationModule(
      unusedConversationModel,
      conversationRepository,
      () => ({ outputLanguage: 'en' as const, targetLanguage: 'en' as const }),
      new Map([[skill.skillId, skill]]),
      conversationRepository
    )
    const { sessionId } = await module.createConversation()

    const first = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'vocabulary',
          arguments: { text: 'apple', wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(first.at(-1)).toMatchObject({ type: 'failed', error: { code: 'PERSISTENCE_ERROR' } })
    const history = await module.loadConversation(sessionId)
    expect(history.messages[0].retryable).toBe(true)
    // 词库已提交：报告存在，重试不得再次写库或调用模型。
    expect(vocabularyRepository.list({}).entries).toHaveLength(1)
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
    expect(vocabularyRepository.list({}).entries).toHaveLength(1)
    const afterRetry = await module.loadConversation(sessionId)
    expect(afterRetry.messages.at(-1)?.content).toContain('1 added')
    expect(afterRetry.messages.at(-1)?.content).toContain('apple')
    expect(afterRetry.messages[0].retryable).toBeUndefined()
    expect(afterRetry.messages).toHaveLength(2)
  })

  it('emits a retryable capability error without persisting a failed batch or assistant reply', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const conversationRepository = new SqliteConversationRepository(database)
    const vocabularyRepository = new SqliteVocabularyRepository(database)
    const skill = makeSkill(vocabularyRepository, async () => {
      throw new VocabularyError('TOOL_CALL_NOT_SUPPORTED')
    })
    const module = new ConversationModule(
      unusedConversationModel,
      conversationRepository,
      () => ({ outputLanguage: 'en' as const, targetLanguage: 'en' as const }),
      new Map([[skill.skillId, skill]]),
      conversationRepository
    )
    const { sessionId } = await module.createConversation()

    const events = await waitForTerminal((emit) =>
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'vocabulary',
          arguments: { text: 'apple', wordLanguage: 'en' }
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
    expect(vocabularyRepository.list({}).entries).toHaveLength(0)
    const history = await module.loadConversation(sessionId)
    expect(history.messages).toHaveLength(1)
    expect(history.messages[0]).toMatchObject({ role: 'user', retryable: true })
    const execution = await conversationRepository.findExecutionByUserMessage(
      sessionId,
      history.messages[0].messageId
    )
    expect(execution).toMatchObject({ phase: 'failed' })
    expect(execution?.batch).toBeUndefined()
  })

  it('rejects a skill invocation whose word language mismatches the configured target language', async () => {
    const database = openDatabase(':memory:')
    databases.push(database)
    const conversationRepository = new SqliteConversationRepository(database)
    const vocabularyRepository = new SqliteVocabularyRepository(database)
    const analyze = vi.fn(async () => insertResult())
    const skill = makeSkill(vocabularyRepository, analyze)
    // 首版 TargetLanguage 只有 'en'；用断言模拟未来扩展后客户端旧值与设置冲突的场景
    const module = new ConversationModule(
      unusedConversationModel,
      conversationRepository,
      () => ({ outputLanguage: 'en', targetLanguage: 'ja' }) as unknown as ConversationLanguages,
      new Map([[skill.skillId, skill]]),
      conversationRepository
    )
    const { sessionId } = await module.createConversation()

    await expect(
      module.runSkill(
        {
          requestId: randomUUID(),
          sessionId,
          skillId: 'vocabulary',
          arguments: { text: 'apple', wordLanguage: 'en' }
        },
        () => undefined
      )
    ).rejects.toThrow(SkillLanguageMismatchError)
    // 拒绝发生在持久化之前：不产生 user 消息、技能执行或词库写入
    expect(analyze).not.toHaveBeenCalled()
    expect(vocabularyRepository.list({}).entries).toHaveLength(0)
    const history = await module.loadConversation(sessionId)
    expect(history.messages).toHaveLength(0)
  })
})

// 第一次 finishExecution 失败：模拟词库已提交但 assistant 消息尚未保存时退出应用。
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
