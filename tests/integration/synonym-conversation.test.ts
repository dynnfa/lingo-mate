import { createTestBatchRuntime } from '../fixtures/python-agent'
import { createTestConversationModule } from '../fixtures/conversation'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../src/database/database'
import { SqliteConversationRepository } from '../../src/database/sqlite-conversation-repository'
import { SqliteSynonymRepository } from '../../src/database/sqlite-synonym-repository'
import { SynonymModule } from '../../src/core/learning/synonym/synonym-module'
import { SynonymConversationSkill } from '../../src/core/learning/synonym/synonym-conversation-skill'
import type { SynonymAnalyzer } from '../../src/core/learning/synonym/synonym-analyzer'
import type { SynonymGroupPage } from '../../src/core/learning/synonym/synonym-repository'
import type { ConversationModule } from '../../src/core/conversation/conversation-module'
import { createSynonymFeedbackFormatter } from '../../src/main/synonym-feedback'
import type { ConversationEvent } from '../../src/shared/conversation'
import { SynonymError } from '../../src/core/learning/synonym/parse-synonym-input'

const databases: Database.Database[] = []
afterEach(() => databases.splice(0).forEach((database) => database.close()))
const normal: SynonymAnalyzer['analyze'] = async ({ messages }) => {
  const word = JSON.parse(String(messages.find((m) => m.role === 'user')!.content)).word as string
  const page =
    messages.at(-1)?.role === 'tool'
      ? (JSON.parse(String(messages.at(-1)!.content)) as SynonymGroupPage)
      : undefined
  const groupid = page?.groups[0]?.id
  const name = !page
    ? 'find_synonym_groups'
    : groupid
      ? 'add_synonym_to_group'
      : 'create_synonym_group_and_add_word'
  const args = {
    word,
    meaning: 'acceptable',
    ...(!page
      ? {}
      : {
          distinction: 'ordinary register',
          ...(groupid ? { groupid } : { groupMeaning: 'acceptable' })
        })
  }
  return {
    canCorrectParallel: false,
    message: {
      tool_calls: [
        { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }
      ]
    }
  }
}

function setup(analyze = vi.fn(normal)): {
  database: Database.Database
  module: ConversationModule
  repository: SqliteConversationRepository
  analyze: ReturnType<typeof vi.fn<SynonymAnalyzer['analyze']>>
  synonym: SqliteSynonymRepository
  service: SynonymModule
} {
  const database = openDatabase(':memory:')
  databases.push(database)
  const repository = new SqliteConversationRepository(database)
  const synonym = new SqliteSynonymRepository(database)
  const service = new SynonymModule(synonym, () => ({ analyze }), createTestBatchRuntime(), 100)
  const skill = new SynonymConversationSkill(service, createSynonymFeedbackFormatter())
  const module = createTestConversationModule(
    {
      async *streamReply() {
        yield { type: 'text' as const, delta: 'hello' }
      }
    },
    repository,
    () => ({ outputLanguage: 'en', targetLanguage: 'en' }),
    new Map([[skill.skillId, skill]]),
    repository
  )
  return { database, module, repository, analyze, synonym, service }
}
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
describe('synonym conversation', () => {
  it('keeps existing words skipped when an earlier new word encounters unsupported tools', async () => {
    const { module, repository, analyze } = setup()
    const { sessionId } = await module.createConversation()
    const run = (text: string): Promise<ConversationEvent[]> =>
      terminal((emit) =>
        module.runSkill(
          {
            sessionId,
            requestId: randomUUID(),
            skillId: 'synonym',
            arguments: { text, wordLanguage: 'en' }
          },
          emit
        )
      )
    await run('decent')
    analyze.mockRejectedValue(new SynonymError('TOOL_CALL_NOT_SUPPORTED'))
    await run('adequate, decent, DECENT, good')
    const history = await module.loadConversation(sessionId)
    const stored = await repository.findExecutionByUserMessage(
      sessionId,
      history.messages[2].messageId
    )
    expect(stored?.batch?.items.map((item) => item.status)).toEqual([
      'failed',
      'existing',
      'duplicate',
      'failed'
    ])
    expect(analyze).toHaveBeenCalledTimes(3)
  })
  it('retries processing after precheck failure instead of replying with the initial checkpoint', async () => {
    const { module, repository, synonym, analyze } = setup()
    const { sessionId } = await module.createConversation()
    vi.spyOn(synonym, 'findExisting').mockImplementationOnce(() => {
      throw new SynonymError('STORAGE_FAILED')
    })
    const events = await terminal((emit) =>
      module.runSkill(
        {
          sessionId,
          requestId: randomUUID(),
          skillId: 'synonym',
          arguments: { text: 'adequate', wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(events.at(-1)?.type).toBe('failed')
    const history = await module.loadConversation(sessionId)
    const userMessageId = history.messages[0].messageId
    expect(
      (await repository.findExecutionByUserMessage(sessionId, userMessageId))?.batch
    ).toMatchObject({ finalized: false })
    const retry = await terminal((emit) =>
      module.retryMessage(
        {
          sessionId,
          requestId: randomUUID(),
          userMessageId
        },
        emit
      )
    )
    expect(retry.at(-1)?.type).toBe('completed')
    expect(analyze).toHaveBeenCalledTimes(2)
    expect((await module.loadConversation(sessionId)).messages.at(-1)?.content).toContain(
      'adequate: added'
    )
  })
  it('resumes a checkpoint without reanalyzing or relabeling committed words', async () => {
    const { module, repository, synonym, analyze, database } = setup()
    const { sessionId } = await module.createConversation()
    const saveReport = synonym.saveReport.bind(synonym)
    let committedReportSaved = false
    vi.spyOn(synonym, 'saveReport').mockImplementation((id, report) => {
      if (report.items[0].status === 'saved' && !report.finalized) {
        if (committedReportSaved) {
          throw new SynonymError('STORAGE_FAILED')
        }
        committedReportSaved = true
      }
      saveReport(id, report)
    })
    const events = await terminal((emit) =>
      module.runSkill(
        {
          sessionId,
          requestId: randomUUID(),
          skillId: 'synonym',
          arguments: { text: 'adequate, decent', wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(events.at(-1)?.type).toBe('failed')
    vi.mocked(synonym.saveReport).mockRestore()
    const history = await module.loadConversation(sessionId)
    const userMessageId = history.messages[0].messageId
    const retry = await terminal((emit) =>
      module.retryMessage(
        {
          sessionId,
          requestId: randomUUID(),
          userMessageId
        },
        emit
      )
    )
    expect(retry.at(-1)?.type).toBe('completed')
    expect(
      analyze.mock.calls
        .filter(([input]) => input.messages.length === 2)
        .map(([input]) => JSON.parse(String(input.messages[1].content)).word)
    ).toEqual(['adequate', 'decent'])
    expect(
      (await repository.findExecutionByUserMessage(sessionId, userMessageId))?.batch?.items.map(
        (item) => item.status
      )
    ).toEqual(['saved', 'saved'])
    expect(database.prepare('SELECT * FROM synonym_group').all()).toHaveLength(1)
    expect(database.prepare('SELECT * FROM synonym').all()).toHaveLength(2)
  })
  it('shares a newly committed group, deduplicates and never calls the model for existing words', async () => {
    const { module, database, analyze, repository } = setup()
    const { sessionId } = await module.createConversation()
    const run = (): Promise<ConversationEvent[]> =>
      terminal((emit) =>
        module.runSkill(
          {
            sessionId,
            requestId: randomUUID(),
            skillId: 'synonym',
            arguments: { text: ' Adequate, decent, ADEQUATE', wordLanguage: 'en' }
          },
          emit
        )
      )
    expect((await run()).at(-1)?.type).toBe('completed')
    expect(database.prepare('SELECT * FROM synonym_group').all()).toHaveLength(1)
    expect(database.prepare('SELECT * FROM synonym').all()).toHaveLength(2)
    expect(analyze).toHaveBeenCalledTimes(4)
    const history = await module.loadConversation(sessionId)
    expect(history.messages[1].content).toContain('adequate: added')
    const stored = await repository.findExecutionByUserMessage(
      sessionId,
      history.messages[0].messageId
    )
    expect(stored?.skillId).toBe('synonym')
    expect(stored?.batch?.items.map((item) => item.status)).toEqual(['saved', 'saved', 'duplicate'])
    await run()
    expect(analyze).toHaveBeenCalledTimes(4)
    expect((await module.loadConversation(sessionId)).messages.at(-1)?.content).toContain(
      'already saved'
    )
  })
  it('retains committed words when a later word fails or times out', async () => {
    const analyze = vi.fn<SynonymAnalyzer['analyze']>(async (input) => {
      if (JSON.parse(String(input.messages[1].content)).word === 'decent')
        await new Promise(() => {})
      else return normal(input)
    })
    const { module, database } = setup(analyze)
    const { sessionId } = await module.createConversation()
    const events = await terminal((emit) =>
      module.runSkill(
        {
          sessionId,
          requestId: randomUUID(),
          skillId: 'synonym',
          arguments: { text: 'adequate,decent', wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(events.at(-1)?.type).toBe('completed')
    expect(database.prepare('SELECT word FROM synonym').all()).toEqual([{ word: 'adequate' }])
    const reply = (await module.loadConversation(sessionId)).messages.at(-1)?.content
    expect(reply).toContain('adequate: added')
    expect(reply).toContain('decent: Timed out')
  })
  it('cancels remaining words while displaying committed ones', async () => {
    let cancel = (): void => {}
    const { module, database, synonym } = setup()
    const saveWord = synonym.saveWord.bind(synonym)
    vi.spyOn(synonym, 'saveWord').mockImplementation((...args) => {
      const saved = saveWord(...args)
      cancel()
      return saved
    })
    const { sessionId } = await module.createConversation()
    const requestId = randomUUID()
    cancel = () => {
      void module.cancelMessage(requestId)
    }
    await terminal((emit) =>
      module.runSkill(
        {
          sessionId,
          requestId,
          skillId: 'synonym',
          arguments: { text: 'adequate,decent', wordLanguage: 'en' }
        },
        emit
      )
    )
    expect(database.prepare('SELECT word FROM synonym').all()).toEqual([{ word: 'adequate' }])
    expect((await module.loadConversation(sessionId)).messages.at(-1)?.content).toContain(
      'decent: cancelled'
    )
  })
  it('restores only the persisted report after reply persistence fails', async () => {
    const { module, repository, analyze } = setup()
    const { sessionId } = await module.createConversation()
    const finish = vi.spyOn(repository, 'finishExecution').mockRejectedValueOnce(new Error('disk'))
    expect(
      (
        await terminal((emit) =>
          module.runSkill(
            {
              sessionId,
              requestId: randomUUID(),
              skillId: 'synonym',
              arguments: { text: 'adequate', wordLanguage: 'en' }
            },
            emit
          )
        )
      ).at(-1)?.type
    ).toBe('failed')
    const history = await module.loadConversation(sessionId)
    const events = await terminal((emit) =>
      module.retryMessage(
        { sessionId, requestId: randomUUID(), userMessageId: history.messages[0].messageId },
        emit
      )
    )
    expect(events.at(-1)?.type).toBe('completed')
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(finish).toHaveBeenCalledTimes(2)
  })
  it('serializes concurrent batches so the second observes the first group', async () => {
    const { module, database } = setup()
    const sessions = await Promise.all([module.createConversation(), module.createConversation()])
    await Promise.all(
      sessions.map(({ sessionId }, index) =>
        terminal((emit) =>
          module.runSkill(
            {
              sessionId,
              requestId: randomUUID(),
              skillId: 'synonym',
              arguments: { text: index ? 'decent' : 'adequate', wordLanguage: 'en' }
            },
            emit
          )
        )
      )
    )
    expect(database.prepare('SELECT * FROM synonym_group').all()).toHaveLength(1)
    expect(database.prepare('SELECT * FROM synonym').all()).toHaveLength(2)
  })
})
