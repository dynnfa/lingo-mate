import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase } from '../database'
import { SqliteChannelStore } from '../sqlite-channel-store'
import type { StoredChannelBinding, StoredChannelInbound } from '../../core/channels/channel-types'

let workspace: string
let databases: Database.Database[]

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'lingo-mate-channels-'))
  databases = []
})

afterEach(async () => {
  for (const database of databases) database.close()
  await rm(workspace, { force: true, recursive: true })
})

function openStore(path = join(workspace, 'channels.sqlite')): SqliteChannelStore {
  const database = openDatabase(path)
  databases.push(database)
  return new SqliteChannelStore(database)
}

const CONNECTION = {
  connectionId: randomUUID(),
  platform: 'telegram' as const,
  botId: '6000000001',
  botUsername: 'lingo_mate_bot',
  createdAt: '2026-09-23T08:00:00.000Z',
  updatedAt: '2026-09-23T08:00:00.000Z'
}

function inboundRecord(overrides: Partial<StoredChannelInbound> = {}): StoredChannelInbound {
  return {
    inboundId: randomUUID(),
    connectionId: CONNECTION.connectionId,
    platform: 'telegram',
    botId: CONNECTION.botId,
    eventId: 1001,
    messageId: 1001,
    chatId: '8000000001',
    senderId: '7000000001',
    sentAt: '2026-09-23T11:59:00.000Z',
    receivedAt: '2026-09-23T12:00:00.000Z',
    text: 'hello',
    kind: 'message',
    status: 'received',
    sessionId: null,
    executionRef: null,
    createdAt: '2026-09-23T12:00:00.000Z',
    updatedAt: '2026-09-23T12:00:00.000Z',
    ...overrides
  }
}

describe('SqliteChannelStore connections', () => {
  it('saves and finds the sole connection, replacing wipes channel state', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    expect(store.findSoleConnection()).toMatchObject({ botId: '6000000001' })

    store.recordInbound(inboundRecord())
    store.saveCursor(CONNECTION.connectionId, 42, '2026-09-23T12:00:00.000Z')
    store.saveReply({
      replyId: randomUUID(),
      connectionId: CONNECTION.connectionId,
      platform: 'telegram',
      chatId: '8000000001',
      senderId: '7000000001',
      sessionId: null,
      inboundId: null,
      text: 'reply',
      status: 'pending',
      attempts: 0,
      createdAt: '2026-09-23T12:00:00.000Z',
      updatedAt: '2026-09-23T12:00:00.000Z',
      sentAt: null
    })

    store.replaceConnection({ ...CONNECTION, botId: '6000000002' })
    expect(store.findSoleConnection()?.botId).toBe('6000000002')
    expect(store.getCursor(CONNECTION.connectionId)).toBeNull()
    expect(store.listRecoverableInbound(CONNECTION.connectionId)).toHaveLength(0)
    // 更换 Bot 后旧连接的待发回复一并丢弃。
    const storeAny = store as unknown as { database: Database.Database }
    const replies = storeAny.database
      .prepare('SELECT COUNT(*) AS count FROM chat_channel_replies WHERE status = ?')
      .get('pending') as { count: number }
    expect(replies.count).toBe(0)
  })

  it('runs migrations idempotently on reopen', () => {
    const path = join(workspace, 'reopen.sqlite')
    openStore(path)
    openStore(path)
  })
})

describe('SqliteChannelStore inbound idempotency', () => {
  it('keeps an executing result recoverable when inserting its reply fails', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    const inbound = inboundRecord({ status: 'executing' })
    store.recordInbound(inbound)
    const database = (store as unknown as { database: Database.Database }).database
    database.exec(`CREATE TRIGGER reject_channel_reply BEFORE INSERT ON chat_channel_replies
      BEGIN SELECT RAISE(ABORT, 'reply insert failed'); END`)
    expect(() =>
      store.saveResult(inbound.inboundId, 'succeeded', {
        replyId: randomUUID(),
        connectionId: CONNECTION.connectionId,
        platform: 'telegram',
        chatId: inbound.chatId,
        senderId: inbound.senderId,
        sessionId: null,
        inboundId: inbound.inboundId,
        text: 'saved',
        status: 'pending',
        attempts: 0,
        createdAt: inbound.createdAt,
        updatedAt: inbound.createdAt,
        sentAt: null
      })
    ).toThrow('reply insert failed')
    expect(store.listRecoverableInbound(CONNECTION.connectionId)[0].status).toBe('executing')
  })

  it('creates once and returns the existing record for duplicate event ids', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    const record = inboundRecord()
    expect(store.recordInbound(record)).toEqual({ created: true })
    const duplicate = store.recordInbound(inboundRecord({ inboundId: randomUUID() }))
    expect(duplicate).toMatchObject({ created: false, existing: { inboundId: record.inboundId } })
  })

  it('patches status, session and execution reference', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    const record = inboundRecord()
    store.recordInbound(record)
    const executionRef = { requestId: randomUUID(), userMessageId: randomUUID() }
    store.updateInbound(
      record.inboundId,
      { status: 'executing', sessionId: 'session-1', executionRef },
      '2026-09-23T12:01:00.000Z'
    )
    const recovered = store.listRecoverableInbound(CONNECTION.connectionId)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ status: 'executing', sessionId: 'session-1' })
    expect(recovered[0].executionRef).toEqual(executionRef)
  })

  it('does not list terminal records as recoverable', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    const record = inboundRecord()
    store.recordInbound(record)
    store.updateInbound(record.inboundId, { status: 'succeeded' }, '2026-09-23T12:01:00.000Z')
    expect(store.listRecoverableInbound(CONNECTION.connectionId)).toHaveLength(0)
  })
})

describe('SqliteChannelStore binding codes', () => {
  it('matches once, counts mismatches, expires and invalidates atomically', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    store.saveBindingCode({
      connectionId: CONNECTION.connectionId,
      code: 'AB23CD',
      createdAt: '2026-09-23T11:50:00.000Z',
      expiresAt: '2026-09-23T12:00:00.000Z',
      consumedAt: null,
      attempts: 0
    })

    expect(
      store.matchBindingCode(CONNECTION.connectionId, 'WRONG1', '2026-09-23T11:55:00.000Z')
    ).toBe('mismatch')
    expect(
      store.matchBindingCode(CONNECTION.connectionId, 'AB23CD', '2026-09-23T11:56:00.000Z')
    ).toBe('matched')
    // 一次性：匹配后再次尝试不再匹配。
    expect(
      store.matchBindingCode(CONNECTION.connectionId, 'AB23CD', '2026-09-23T11:57:00.000Z')
    ).toBe('none')
  })

  it('reports expired codes and exhausted attempts', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    store.saveBindingCode({
      connectionId: CONNECTION.connectionId,
      code: 'AB23CD',
      createdAt: '2026-09-23T11:50:00.000Z',
      expiresAt: '2026-09-23T11:55:00.000Z',
      consumedAt: null,
      attempts: 0
    })
    expect(
      store.matchBindingCode(CONNECTION.connectionId, 'AB23CD', '2026-09-23T11:56:00.000Z')
    ).toBe('expired')

    store.saveBindingCode({
      connectionId: CONNECTION.connectionId,
      code: 'EF45GH',
      createdAt: '2026-09-23T12:00:00.000Z',
      expiresAt: '2026-09-23T12:10:00.000Z',
      consumedAt: null,
      attempts: 0
    })
    for (let index = 0; index < 4; index += 1) {
      expect(
        store.matchBindingCode(CONNECTION.connectionId, 'WRONG1', '2026-09-23T12:01:00.000Z')
      ).toBe('mismatch')
    }
    expect(
      store.matchBindingCode(CONNECTION.connectionId, 'WRONG1', '2026-09-23T12:01:00.000Z')
    ).toBe('exhausted')
    expect(
      store.matchBindingCode(CONNECTION.connectionId, 'EF45GH', '2026-09-23T12:01:00.000Z')
    ).toBe('none')
  })
})

describe('SqliteChannelStore bindings', () => {
  it('transitions pending bindings to active and back to unbound', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    const binding: StoredChannelBinding = {
      bindingId: randomUUID(),
      connectionId: CONNECTION.connectionId,
      platform: 'telegram',
      senderId: '7000000001',
      chatId: '8000000001',
      displayName: 'Leon',
      status: 'pending',
      requestedAt: '2026-09-23T11:58:00.000Z',
      confirmedAt: null,
      unboundAt: null
    }
    store.insertPendingBinding(binding)
    expect(store.findPendingBinding(CONNECTION.connectionId)?.bindingId).toBe(binding.bindingId)

    store.confirmPendingBinding(binding.bindingId, '2026-09-23T11:59:00.000Z')
    const active = store.findActiveBinding(CONNECTION.connectionId)
    expect(active).toMatchObject({ status: 'active', confirmedAt: '2026-09-23T11:59:00.000Z' })
    expect(store.findActiveBindingBySender(CONNECTION.connectionId, '7000000001')?.bindingId).toBe(
      binding.bindingId
    )

    store.markBindingUnbound(CONNECTION.connectionId, '2026-09-23T12:30:00.000Z')
    expect(store.findActiveBinding(CONNECTION.connectionId)).toBeUndefined()
  })

  it('allows only one pending and one active binding per connection', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    store.insertPendingBinding({
      bindingId: randomUUID(),
      connectionId: CONNECTION.connectionId,
      platform: 'telegram',
      senderId: '7000000001',
      chatId: '8000000001',
      displayName: null,
      status: 'pending',
      requestedAt: '2026-09-23T11:58:00.000Z',
      confirmedAt: null,
      unboundAt: null
    })
    expect(() =>
      store.insertPendingBinding({
        bindingId: randomUUID(),
        connectionId: CONNECTION.connectionId,
        platform: 'telegram',
        senderId: '7000000002',
        chatId: '8000000002',
        displayName: null,
        status: 'pending',
        requestedAt: '2026-09-23T11:58:30.000Z',
        confirmedAt: null,
        unboundAt: null
      })
    ).toThrow()
  })
})

describe('SqliteChannelStore sessions, cursor and replies', () => {
  it('maps session keys to the latest created session', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    const key = `telegram:${CONNECTION.connectionId}:7000000001:8000000001`
    store.createSession({
      sessionId: randomUUID(),
      connectionId: CONNECTION.connectionId,
      sessionKey: key,
      createdAt: '2026-09-23T12:00:00.000Z',
      updatedAt: '2026-09-23T12:00:00.000Z'
    })
    const second = randomUUID()
    store.createSession({
      sessionId: second,
      connectionId: CONNECTION.connectionId,
      sessionKey: key,
      createdAt: '2026-09-23T12:10:00.000Z',
      updatedAt: '2026-09-23T12:10:00.000Z'
    })
    expect(store.findActiveSessionId(key)).toBe(second)
  })

  it('persists the polling cursor', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    expect(store.getCursor(CONNECTION.connectionId)).toBeNull()
    store.saveCursor(CONNECTION.connectionId, 100, '2026-09-23T12:00:00.000Z')
    expect(store.getCursor(CONNECTION.connectionId)).toBe(100)
  })

  it('tracks reply delivery lifecycle and drops pending replies', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    const replyId = randomUUID()
    store.saveReply({
      replyId,
      connectionId: CONNECTION.connectionId,
      platform: 'telegram',
      chatId: '8000000001',
      senderId: '7000000001',
      sessionId: null,
      inboundId: null,
      text: 'reply',
      status: 'pending',
      attempts: 0,
      createdAt: '2026-09-23T12:00:00.000Z',
      updatedAt: '2026-09-23T12:00:00.000Z',
      sentAt: null
    })
    store.markReplyAttemptFailed(replyId, '2026-09-23T12:00:05.000Z', 'pending')
    expect(store.listPendingReplies(CONNECTION.connectionId)).toHaveLength(1)

    store.markReplySent(replyId, '2026-09-23T12:00:10.000Z')
    expect(store.listPendingReplies(CONNECTION.connectionId)).toHaveLength(0)

    const otherId = randomUUID()
    store.saveReply({
      replyId: otherId,
      connectionId: CONNECTION.connectionId,
      platform: 'telegram',
      chatId: '8000000001',
      senderId: '7000000001',
      sessionId: null,
      inboundId: null,
      text: 'later',
      status: 'pending',
      attempts: 0,
      createdAt: '2026-09-23T12:01:00.000Z',
      updatedAt: '2026-09-23T12:01:00.000Z',
      sentAt: null
    })
    store.dropPendingReplies(CONNECTION.connectionId)
    expect(store.listPendingReplies(CONNECTION.connectionId)).toHaveLength(0)
  })
})

describe('SqliteChannelStore confirmations', () => {
  it('replaces the active confirmation per session and consumes it once', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    const sessionId = randomUUID()
    const scope = {
      connectionId: CONNECTION.connectionId,
      sessionId,
      chatId: '8000000001',
      senderId: '7000000001'
    }
    store.saveConfirmation({
      operationId: randomUUID(),
      connectionId: scope.connectionId,
      sessionId,
      chatId: scope.chatId,
      senderId: scope.senderId,
      messageRef: 1001,
      words: ['apple'],
      targetLanguage: 'en',
      explanationLanguage: 'zh-CN',
      createdAt: '2026-09-23T12:00:00.000Z',
      expiresAt: '2026-09-23T12:05:00.000Z',
      consumedAt: null
    })
    expect(store.findActiveConfirmation(scope)?.words).toEqual(['apple'])

    const operationId = randomUUID()
    store.saveConfirmation({
      operationId,
      connectionId: scope.connectionId,
      sessionId,
      chatId: scope.chatId,
      senderId: scope.senderId,
      messageRef: 1002,
      words: ['banana'],
      targetLanguage: 'en',
      explanationLanguage: 'zh-CN',
      createdAt: '2026-09-23T12:01:00.000Z',
      expiresAt: '2026-09-23T12:06:00.000Z',
      consumedAt: null
    })
    expect(store.findActiveConfirmation(scope)?.words).toEqual(['banana'])

    expect(store.consumeConfirmation(operationId, '2026-09-23T12:02:00.000Z').outcome).toBe(
      'consumed'
    )
    expect(store.consumeConfirmation(operationId, '2026-09-23T12:02:30.000Z').outcome).toBe(
      'missing'
    )
    expect(store.findActiveConfirmation(scope)).toBeUndefined()
  })

  it('refuses to consume expired confirmations and invalidates by session or owner', () => {
    const store = openStore()
    store.saveConnection(CONNECTION)
    const sessionId = randomUUID()
    const scope = {
      connectionId: CONNECTION.connectionId,
      sessionId,
      chatId: '8000000001',
      senderId: '7000000001'
    }
    const operationId = randomUUID()
    store.saveConfirmation({
      operationId,
      connectionId: scope.connectionId,
      sessionId,
      chatId: scope.chatId,
      senderId: scope.senderId,
      messageRef: 1001,
      words: ['apple'],
      targetLanguage: 'en',
      explanationLanguage: 'zh-CN',
      createdAt: '2026-09-23T12:00:00.000Z',
      expiresAt: '2026-09-23T12:05:00.000Z',
      consumedAt: null
    })
    expect(store.consumeConfirmation(operationId, '2026-09-23T12:06:00.000Z').outcome).toBe(
      'expired'
    )

    // 过期后失效，不能再被发现。
    expect(store.findActiveConfirmation(scope)).toBeUndefined()

    // 会话级与归属级作废。
    const secondId = randomUUID()
    store.saveConfirmation({
      operationId: secondId,
      connectionId: scope.connectionId,
      sessionId,
      chatId: scope.chatId,
      senderId: scope.senderId,
      messageRef: 1003,
      words: ['cherry'],
      targetLanguage: 'en',
      explanationLanguage: 'zh-CN',
      createdAt: '2026-09-23T12:07:00.000Z',
      expiresAt: '2026-09-23T12:12:00.000Z',
      consumedAt: null
    })
    store.invalidateSessionConfirmation(scope)
    expect(store.findActiveConfirmation(scope)).toBeUndefined()

    const thirdId = randomUUID()
    store.saveConfirmation({
      operationId: thirdId,
      connectionId: scope.connectionId,
      sessionId,
      chatId: scope.chatId,
      senderId: scope.senderId,
      messageRef: 1004,
      words: ['date'],
      targetLanguage: 'en',
      explanationLanguage: 'zh-CN',
      createdAt: '2026-09-23T12:13:00.000Z',
      expiresAt: '2026-09-23T12:18:00.000Z',
      consumedAt: null
    })
    store.invalidateAllConfirmations(CONNECTION.connectionId)
    expect(store.findActiveConfirmation(scope)).toBeUndefined()
  })
})
