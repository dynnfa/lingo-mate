import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase } from '../database'
import { SqliteChannelStore } from '../sqlite-channel-store'
import { SqliteChannelConversationRepository } from '../sqlite-channel-conversation-repository'
import { SqliteConversationRepository } from '../sqlite-conversation-repository'
import type {
  StoredConversation,
  StoredMessage
} from '../../core/conversation/conversation-repository'
import type { StoredConversationSkillExecution } from '../../core/conversation/conversation-skill-repository'
import type { StoredChannelConnection } from '../../core/channels/channel-types'

let workspace: string
let databases: Database.Database[]

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'lingo-mate-channel-sessions-'))
  databases = []
})

afterEach(async () => {
  for (const database of databases) database.close()
  await rm(workspace, { force: true, recursive: true })
})

function openRepositories(path = join(workspace, 'channels.sqlite')): {
  database: Database.Database
  store: SqliteChannelStore
  repository: SqliteChannelConversationRepository
  desktopRepository: SqliteConversationRepository
} {
  const database = openDatabase(path)
  databases.push(database)
  const store = new SqliteChannelStore(database)
  const repository = new SqliteChannelConversationRepository(database)
  const desktopRepository = new SqliteConversationRepository(database)
  return { database, store, repository, desktopRepository }
}

const CONNECTION: StoredChannelConnection = {
  connectionId: randomUUID(),
  platform: 'telegram',
  botId: '6000000001',
  botUsername: null,
  createdAt: '2026-09-23T08:00:00.000Z',
  updatedAt: '2026-09-23T08:00:00.000Z'
}

function conversation(): StoredConversation {
  return {
    id: randomUUID(),
    title: 'draft title',
    createdAt: '2026-09-23T12:00:00.000Z',
    updatedAt: '2026-09-23T12:00:00.000Z'
  }
}

// 渠道会话的创建入口是 ChannelStore.createSession（含 session_key 与活动指针）。
function registerSession(store: SqliteChannelStore, session: StoredConversation): void {
  store.createSession({
    sessionId: session.id,
    connectionId: CONNECTION.connectionId,
    sessionKey: `telegram:${CONNECTION.connectionId}:7000000001:8000000001`,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  })
}

function message(sessionId: string, content: string, at: string): StoredMessage {
  return {
    id: randomUUID(),
    sessionId,
    role: 'user',
    content,
    createdAt: at
  }
}

describe('SqliteChannelConversationRepository', () => {
  it('persists channel sessions and messages separately from desktop conversations', async () => {
    const { store, repository, desktopRepository } = openRepositories()
    store.saveConnection(CONNECTION)
    const session = conversation()
    registerSession(store, session)
    await repository.appendMessage(message(session.id, 'hello', '2026-09-23T12:00:01.000Z'))

    expect(await repository.find(session.id)).toMatchObject({ id: session.id })
    expect((await repository.history(session.id)).map((m) => m.content)).toEqual(['hello'])
    // 桌面会话列表与读取不能触达外部会话。
    expect(await desktopRepository.list()).toHaveLength(0)
    expect(await desktopRepository.find(session.id)).toBeUndefined()
    expect(await desktopRepository.history(session.id)).toHaveLength(0)
  })

  it('appends messages transactionally with first-message session creation', async () => {
    const { store, repository } = openRepositories()
    store.saveConnection(CONNECTION)
    const session = conversation()
    registerSession(store, session)
    const first = message(session.id, 'first', '2026-09-23T12:00:01.000Z')
    await repository.appendMessage(first)
    const second = {
      ...message(session.id, 'second', '2026-09-23T12:00:02.000Z'),
      role: 'assistant' as const
    }
    await repository.appendMessage(second)

    const history = await repository.history(session.id)
    expect(history.map((m) => [m.role, m.content])).toEqual([
      ['user', 'first'],
      ['assistant', 'second']
    ])
  })

  it('tracks skill executions with phases and committed batches', async () => {
    const { database, store, repository } = openRepositories()
    store.saveConnection(CONNECTION)
    const session = conversation()
    registerSession(store, session)
    const user = message(session.id, '/save apple', '2026-09-23T12:00:01.000Z')
    const execution: StoredConversationSkillExecution = {
      id: randomUUID(),
      sessionId: session.id,
      userMessageId: user.id,
      skillId: 'vocabulary',
      arguments: { text: 'apple', wordLanguage: 'en' },
      explanationLanguage: 'zh-CN',
      phase: 'started',
      createdAt: '2026-09-23T12:00:02.000Z',
      updatedAt: '2026-09-23T12:00:02.000Z'
    }
    await repository.createExecution(execution, user, session)

    await repository.setExecutionPhase(execution.id, 'analyzing')
    const mid = await repository.findExecutionByUserMessage(session.id, user.id)
    expect(mid).toMatchObject({ phase: 'analyzing', skillId: 'vocabulary' })

    // 模拟词库提交批次落盘（生产由词库仓储在同一事务写入渠道执行表）。
    const batch = {
      requestId: randomUUID(),
      outcome: 'completed',
      explanationLanguage: 'zh-CN',
      items: [
        {
          status: 'saved',
          inputIndex: 0,
          term: 'apple',
          entryId: randomUUID()
        }
      ],
      counts: { total: 1, saved: 1, existing: 0, duplicate: 0, failed: 0 }
    }
    database
      .prepare(
        `UPDATE chat_channel_skill_executions SET batch_json = ?, phase = 'summarizing' WHERE id = ?`
      )
      .run(JSON.stringify(batch), execution.id)

    const assistant = {
      ...message(session.id, 'saved: apple', '2026-09-23T12:00:03.000Z'),
      role: 'assistant' as const
    }
    await repository.finishExecution(execution.id, 'completed', assistant)
    const finished = await repository.findExecutionByUserMessage(session.id, user.id)
    expect(finished).toMatchObject({ phase: 'completed', assistantMessageId: assistant.id })
    expect(finished?.batch).toMatchObject({ counts: { saved: 1 } })
  })

  it('survives restart with sessions, history and executions intact', async () => {
    const path = join(workspace, 'restart.sqlite')
    const sessionId = randomUUID()
    const executionId = randomUUID()
    const userMessageId = randomUUID()
    {
      const { store, repository } = openRepositories(path)
      store.saveConnection(CONNECTION)
      const session = { ...conversation(), id: sessionId }
      registerSession(store, session)
      const user = {
        ...message(sessionId, '/save apple', '2026-09-23T12:00:01.000Z'),
        id: userMessageId
      }
      await repository.createExecution(
        {
          id: executionId,
          sessionId,
          userMessageId,
          skillId: 'vocabulary',
          arguments: { text: 'apple', wordLanguage: 'en' },
          explanationLanguage: 'zh-CN',
          phase: 'summarizing',
          createdAt: '2026-09-23T12:00:02.000Z',
          updatedAt: '2026-09-23T12:00:02.000Z'
        },
        user
      )
    }
    const { store, repository } = openRepositories(path)
    expect(store.findConnection(CONNECTION.connectionId)).toBeDefined()
    expect(await repository.find(sessionId)).toMatchObject({ id: sessionId })
    expect((await repository.history(sessionId)).map((m) => m.content)).toEqual(['/save apple'])
    const execution = await repository.findExecutionByUserMessage(sessionId, userMessageId)
    expect(execution).toMatchObject({ id: executionId, phase: 'summarizing' })
  })
})
