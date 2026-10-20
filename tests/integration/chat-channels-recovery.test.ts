import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase } from '../../src/database/database'
import { SqliteChannelStore } from '../../src/database/sqlite-channel-store'
import { SqliteChannelConversationRepository } from '../../src/database/sqlite-channel-conversation-repository'
import { SqliteVocabularyRepository } from '../../src/database/sqlite-vocabulary-repository'
import { SqliteConversationRepository } from '../../src/database/sqlite-conversation-repository'
import { VocabularyConversationSkill } from '../../src/core/learning/vocabulary/vocabulary-conversation-skill'
import { ConversationModule } from '../../src/core/conversation/conversation-module'
import { ChannelModule } from '../../src/core/channels/channel-module'
import type { ChannelStore } from '../../src/core/channels/channel-store'
import type {
  ChannelIntentResult,
  ChannelOutboundTarget,
  ChannelTransport,
  ChatChannelReplies,
  InboundChannelMessage
} from '../../src/core/channels/channel-types'
import type {
  LanguageModel,
  ModelStreamEvent,
  StreamReplyInput
} from '../../src/core/llm/language-model'
import type { SupportedLocale, TargetLanguage } from '../../src/shared/preferences'

// 聊天平台接入的存储与恢复集成验证：真实 SQLite（临时文件库）+ 假模型、
// 假分析器与假平台传输。覆盖词库提交与渠道结果落盘之间的崩溃窗口、
// 重启补发、重投幂等与桌面会话隔离。

let workspace: string
let databases: Database.Database[]

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'lingo-mate-channels-it-'))
  databases = []
})

afterEach(async () => {
  for (const database of databases) database.close()
  await rm(workspace, { force: true, recursive: true })
})

const CONNECTION_ID = randomUUID()

class SuccessfulModel implements LanguageModel {
  readonly inputs: StreamReplyInput[] = []
  async *streamReply(input: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
    this.inputs.push(input)
    yield { type: 'text', delta: `assistant:${input.messages.at(-1)?.content ?? ''}` }
  }
}

class RecordingTransport implements ChannelTransport {
  readonly sent: Array<{ target: ChannelOutboundTarget; text: string }> = []
  outcome: { delivered: boolean } = { delivered: true }

  async send(target: ChannelOutboundTarget, text: string): Promise<{ delivered: boolean }> {
    this.sent.push({ target, text })
    return this.outcome
  }
}

function fakeReplies(): ChatChannelReplies {
  const tag = (name: string) => () => `${name}`
  return {
    help: tag('help'),
    notBound: tag('notBound'),
    alreadyBound: tag('alreadyBound'),
    bindingRequested: tag('bindingRequested'),
    bindingCodeMismatch: tag('bindingCodeMismatch'),
    bindingCodeExpired: tag('bindingCodeExpired'),
    bindingCodeExhausted: tag('bindingCodeExhausted'),
    noActiveBindingCode: tag('noActiveBindingCode'),
    confirmationPrompt: () => 'confirmationPrompt',
    confirmNoPending: tag('confirmNoPending'),
    confirmLanguageChanged: () => 'confirmLanguageChanged',
    confirmExpired: tag('confirmExpired'),
    intentClarify: tag('intentClarify'),
    cancelReport: () => 'cancelReport',
    cancelIdle: tag('cancelIdle'),
    newSessionBusy: tag('newSessionBusy'),
    newSessionStarted: tag('newSessionStarted'),
    queueBusy: tag('queueBusy'),
    rateLimited: tag('rateLimited'),
    messageTooLong: tag('messageTooLong'),
    executionFailed: tag('executionFailed'),
    needsAttention: tag('needsAttention')
  }
}

interface Harness {
  database: Database.Database
  store: ChannelStore & SqliteChannelStore
  channelRepository: SqliteChannelConversationRepository
  desktopRepository: SqliteConversationRepository
  vocabularyRepository: SqliteVocabularyRepository
  desktopVocabularyRepository: SqliteVocabularyRepository
  model: SuccessfulModel
  transport: RecordingTransport
  module: ChannelModule
  inbound: (overrides?: Partial<InboundChannelMessage>) => InboundChannelMessage
}

// 渠道装配与生产一致：词库仓储的技能执行批次写入渠道执行表，
// 渠道 ConversationModule 复用技能并关闭标题生成。
function buildHarness(path: string, previous?: Harness): Harness {
  const database = previous ? previous.database : openDatabase(path)
  if (!previous) databases.push(database)
  const store = new SqliteChannelStore(database)
  const channelRepository = new SqliteChannelConversationRepository(database)
  const vocabularyRepository = new SqliteVocabularyRepository(database, {
    skillExecutionTable: 'chat_channel_skill_executions'
  })
  const desktopRepository = new SqliteConversationRepository(database)
  const desktopVocabularyRepository = new SqliteVocabularyRepository(database)
  const model = previous?.model ?? new SuccessfulModel()
  const languages = {
    outputLanguage: 'zh-CN' as SupportedLocale,
    targetLanguage: 'en' as TargetLanguage
  }
  const vocabularySkill = new VocabularyConversationSkill(
    vocabularyRepository,
    () => ({
      analyzer: {
        analyze: async ({ term }: { term: string }) => ({
          status: 'insert' as const,
          content: {
            term,
            phonetic: ['/ˈtekst/'],
            meaning: '集成测试释义',
            concept: '集成测试概念',
            exampleSentences: ['Integration test sentence.']
          },
          modelId: 'fixture-model',
          promptVersion: 'vocabulary-tools-v4'
        })
      }
    }),
    (batch) => `vocab-feedback:saved=${batch.counts.saved},existing=${batch.counts.existing}`
  )
  const skills = new Map([[vocabularySkill.skillId, vocabularySkill]])
  const conversations = new ConversationModule(
    model,
    channelRepository,
    () => languages,
    skills,
    channelRepository,
    undefined,
    { generateTitles: false }
  )
  const transport = previous?.transport ?? new RecordingTransport()
  const module = new ChannelModule({
    store,
    conversations,
    conversationStore: channelRepository,
    skills,
    intentRecognizer: {
      recognize: async (): Promise<ChannelIntentResult> => ({ status: 'none' })
    },
    replies: fakeReplies(),
    transport,
    resolveLanguages: () => languages,
    now: () => new Date('2026-09-23T12:00:00.000Z')
  })
  let eventSeq = previous ? 40_000 : 20_000
  const inbound = (overrides: Partial<InboundChannelMessage> = {}): InboundChannelMessage => {
    eventSeq += 1
    return {
      platform: 'telegram',
      connectionId: CONNECTION_ID,
      botId: '6000000001',
      eventId: eventSeq,
      messageId: eventSeq,
      senderId: '7000000001',
      chatId: '8000000001',
      sentAt: '2026-09-23T11:59:00.000Z',
      receivedAt: '2026-09-23T12:00:00.000Z',
      text: 'hello',
      senderName: 'Leon',
      ...overrides
    }
  }
  return {
    database,
    store,
    channelRepository,
    desktopRepository,
    vocabularyRepository,
    desktopVocabularyRepository,
    model,
    transport,
    module,
    inbound
  }
}

async function bind(harness: Harness): Promise<void> {
  const { code } = await harness.module.issueBindingCode()
  await harness.module.handleInbound(harness.inbound({ text: `/start ${code}` }))
  await harness.module.confirmPendingBinding()
  await vi.waitFor(() => {
    expect(harness.transport.sent.some(({ text }) => text === 'bindingRequested')).toBe(true)
  })
}

async function waitForSend(harness: Harness, predicate: (text: string) => boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.transport.sent.some(({ text }) => predicate(text))).toBe(true)
  })
}

describe('chat channels storage and recovery (sqlite)', () => {
  it('completes bind → save → reply and shares the vocabulary with the desktop', async () => {
    const harness = buildHarness(join(workspace, 'it.sqlite'))
    harness.store.saveConnection({
      connectionId: CONNECTION_ID,
      platform: 'telegram',
      botId: '6000000001',
      botUsername: null,
      createdAt: '2026-09-23T08:00:00.000Z',
      updatedAt: '2026-09-23T08:00:00.000Z'
    })
    await bind(harness)

    await harness.module.handleInbound(harness.inbound({ text: '/save apple' }))
    await waitForSend(harness, (text) => text === 'vocab-feedback:saved=1,existing=0')

    // 桌面词库读取到同一词条；桌面会话列表读不到外部会话。
    expect(harness.desktopVocabularyRepository.list({}).entries.map((e) => e.term)).toEqual([
      'apple'
    ])
    expect(await harness.desktopRepository.list()).toHaveLength(0)
  })

  it('rebuilds the pending reply from the committed batch after a crash window', async () => {
    const path = join(workspace, 'crash.sqlite')
    const harness = buildHarness(path)
    harness.store.saveConnection({
      connectionId: CONNECTION_ID,
      platform: 'telegram',
      botId: '6000000001',
      botUsername: null,
      createdAt: '2026-09-23T08:00:00.000Z',
      updatedAt: '2026-09-23T08:00:00.000Z'
    })
    await bind(harness)
    await harness.module.handleInbound(harness.inbound({ text: '/save apple' }))
    await waitForSend(harness, (text) => text === 'vocab-feedback:saved=1,existing=0')

    // 模拟崩溃窗口：词库与执行批次已提交、渠道回复未落盘、入站停在执行中。
    harness.database.prepare('DELETE FROM chat_channel_replies').run()
    const inboundRow = harness.database
      .prepare(`SELECT inbound_id FROM chat_channel_inbound WHERE text = '/save apple'`)
      .get() as { inbound_id: string }
    harness.database
      .prepare(`UPDATE chat_channel_inbound SET status = 'executing' WHERE inbound_id = ?`)
      .run(inboundRow.inbound_id)
    harness.transport.sent.length = 0

    const restarted = buildHarness(path, harness)
    await restarted.module.recover()
    await waitForSend(restarted, (text) => text === 'vocab-feedback:saved=1,existing=0')
    // 不重新执行收藏：词条仍只有一个。
    expect(restarted.desktopVocabularyRepository.list({}).entries).toHaveLength(1)
    const status = restarted.database
      .prepare(`SELECT status FROM chat_channel_inbound WHERE inbound_id = ?`)
      .get(inboundRow.inbound_id) as { status: string }
    expect(status.status).toBe('succeeded')
  })

  it('redelivers pending replies after restart without re-executing', async () => {
    const path = join(workspace, 'redeliver.sqlite')
    const harness = buildHarness(path)
    harness.store.saveConnection({
      connectionId: CONNECTION_ID,
      platform: 'telegram',
      botId: '6000000001',
      botUsername: null,
      createdAt: '2026-09-23T08:00:00.000Z',
      updatedAt: '2026-09-23T08:00:00.000Z'
    })
    await bind(harness)
    harness.transport.outcome = { delivered: false }
    await harness.module.handleInbound(harness.inbound({ text: 'question' }))
    await vi.waitFor(() => {
      const pending = harness.database
        .prepare(`SELECT COUNT(*) AS count FROM chat_channel_replies WHERE status = 'pending'`)
        .get() as { count: number }
      expect(pending.count).toBe(1)
    })
    const modelCalls = harness.model.inputs.length

    harness.transport.outcome = { delivered: true }
    const restarted = buildHarness(path, harness)
    await restarted.module.recover()
    await waitForSend(restarted, (text) => text === 'assistant:question')
    expect(harness.model.inputs).toHaveLength(modelCalls)
  })

  it('ignores redelivered updates and resumes from the stored cursor', async () => {
    const path = join(workspace, 'cursor.sqlite')
    const harness = buildHarness(path)
    harness.store.saveConnection({
      connectionId: CONNECTION_ID,
      platform: 'telegram',
      botId: '6000000001',
      botUsername: null,
      createdAt: '2026-09-23T08:00:00.000Z',
      updatedAt: '2026-09-23T08:00:00.000Z'
    })
    await bind(harness)

    const message = harness.inbound({ text: '/save apple', eventId: 777, messageId: 777 })
    await harness.module.handleInbound(message)
    await waitForSend(harness, (text) => text === 'vocab-feedback:saved=1,existing=0')

    // 适配器按顺序持久化入站并推进游标。
    harness.store.saveCursor(CONNECTION_ID, 778, '2026-09-23T12:00:05.000Z')
    expect(harness.store.getCursor(CONNECTION_ID)).toBe(778)

    // 同一 update 重投（重启后游标丢失等场景）：不重复执行、不重复写入。
    const restarted = buildHarness(path, harness)
    await restarted.module.handleInbound({ ...message, messageId: 777 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(restarted.desktopVocabularyRepository.list({}).entries).toHaveLength(1)
    const inboundCount = restarted.database
      .prepare(`SELECT COUNT(*) AS count FROM chat_channel_inbound WHERE event_id = 777`)
      .get() as { count: number }
    expect(inboundCount.count).toBe(1)
  })

  it('keeps channel sessions invisible to the desktop conversation list after restart', async () => {
    const path = join(workspace, 'isolation.sqlite')
    const harness = buildHarness(path)
    harness.store.saveConnection({
      connectionId: CONNECTION_ID,
      platform: 'telegram',
      botId: '6000000001',
      botUsername: null,
      createdAt: '2026-09-23T08:00:00.000Z',
      updatedAt: '2026-09-23T08:00:00.000Z'
    })
    await bind(harness)
    await harness.module.handleInbound(harness.inbound({ text: 'a question' }))
    await waitForSend(harness, (text) => text === 'assistant:a question')

    const restarted = buildHarness(path, harness)
    expect(await restarted.desktopRepository.list()).toHaveLength(0)
    // 猜测 sessionId 也无法从桌面仓储读取外部历史。
    const sessionId = restarted.store.findActiveSessionId(
      `telegram:${CONNECTION_ID}:7000000001:8000000001`
    )
    expect(sessionId).toBeDefined()
    expect(await restarted.desktopRepository.find(sessionId!)).toBeUndefined()
    expect(await restarted.desktopRepository.history(sessionId!)).toHaveLength(0)
    // 渠道侧可继续对话，历史保留。
    const channelHistory = await restarted.channelRepository.history(sessionId!)
    expect(channelHistory.map((m) => m.content)).toEqual(['a question', 'assistant:a question'])
  })
})
