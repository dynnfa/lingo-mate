import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { MIGRATIONS, migrateDatabase } from '../migrations'
import { afterAll, afterEach, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { SqliteConversationRepository } from '../sqlite-conversation-repository'
import { SqliteSentenceRepository } from '../sqlite-sentence-repository'

const db = openDatabase(':memory:')
afterEach(() => db.exec('DELETE FROM sentence'))
afterAll(() => db.close())

async function execution(): Promise<string> {
  const id = randomUUID()
  const sessionId = randomUUID()
  const messageId = randomUUID()
  const now = new Date().toISOString()
  await new SqliteConversationRepository(db).createExecution(
    {
      id,
      sessionId,
      userMessageId: messageId,
      skillId: 'sentence',
      arguments: { text: '今天先这样吧。\n明天继续。', wordLanguage: 'en' },
      explanationLanguage: 'zh-CN',
      phase: 'committing',
      createdAt: now,
      updatedAt: now
    },
    {
      id: messageId,
      sessionId,
      role: 'user',
      content: '/sentence 今天先这样吧。\n明天继续。',
      createdAt: now
    },
    { id: sessionId, title: 'Test', createdAt: now, updatedAt: now }
  )
  return id
}

it('atomically saves a whole paragraph and reuses the existing translation', async () => {
  const repository = new SqliteSentenceRepository(db)
  const input = {
    sourceText: '今天先这样吧。\n明天继续。',
    translation: "Let's call it a day.\nWe can pick this up tomorrow.",
    targetLanguage: 'en' as const
  }
  const first = repository.commit(await execution(), randomUUID(), 'zh-CN', input)
  expect(first.status).toBe('saved')
  expect(first.entry).toMatchObject(input)
  const again = repository.commit(await execution(), randomUUID(), 'zh-CN', {
    ...input,
    translation: 'Different'
  })
  expect(again).toMatchObject({ status: 'existing', entry: first.entry })
  expect(repository.list({}).entries).toEqual([first.entry])
})

it('rolls back a sentence if saving its execution report fails', () => {
  const repository = new SqliteSentenceRepository(db)
  expect(() =>
    repository.commit(randomUUID(), randomUUID(), 'en', {
      sourceText: '原文',
      translation: 'Original',
      targetLanguage: 'en'
    })
  ).toThrow('STORAGE_FAILED')
  expect(repository.list({}).entries).toEqual([])
})
it('paginates newest first and keeps a deleted cursor usable', async () => {
  const repository = new SqliteSentenceRepository(db)
  for (const sourceText of ['one', 'two', 'three'])
    repository.commit(await execution(), randomUUID(), 'en', {
      sourceText,
      translation: sourceText,
      targetLanguage: 'en'
    })
  const first = repository.list({ limit: 2 })
  expect(first.entries).toHaveLength(2)
  expect(first.nextCursor).toBeDefined()
  expect(repository.delete(first.nextCursor!.id)).toBe(true)
  expect(repository.delete(first.nextCursor!.id)).toBe(false)
  const next = repository.list({ limit: 2, cursor: first.nextCursor })
  expect(next.entries).toHaveLength(1)
  expect(first.entries.map((entry) => entry.id)).not.toContain(next.entries[0].id)
  expect(next.nextCursor).toBeUndefined()
})
it('upgrades v13 with existing TTS audio, conversations, reports and usage intact', () => {
  const legacy = new Database(':memory:')
  legacy.pragma('foreign_keys = ON')
  try {
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 13)) migration.up(legacy)
    legacy.pragma('user_version = 13')
    legacy.exec(`INSERT INTO conversations VALUES ('s','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','Old');
      INSERT INTO conversation_messages VALUES ('m','s','user','/tts old','2026-10-01T00:00:00Z');
      INSERT INTO conversation_skill_executions (id,session_id,user_message_id,skill_id,arguments_json,explanation_language,phase,batch_json,created_at,updated_at)
      VALUES ('e','s','m','tts','{}','en','completed','{"preserved":true}','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
      INSERT INTO conversation_speech_assets VALUES ('e','{}',zeroblob(45));
      INSERT INTO llm_request_usage(id,operation,model_id,started_at,status,usage_status) VALUES ('u','conversation','old',1,'completed','missing');`)
    migrateDatabase(legacy)
    migrateDatabase(legacy)
    expect(legacy.pragma('foreign_key_check')).toEqual([])
    expect(
      legacy
        .prepare(
          'SELECT length(audio) AS size FROM conversation_speech_assets WHERE execution_id = ?'
        )
        .get('e')
    ).toEqual({ size: 45 })
    expect(
      legacy.prepare('SELECT batch_json FROM conversation_skill_executions WHERE id = ?').get('e')
    ).toEqual({ batch_json: '{"preserved":true}' })
    expect(legacy.prepare('SELECT model_id FROM llm_request_usage').get()).toEqual({
      model_id: 'old'
    })
    expect(legacy.prepare('SELECT title FROM conversations').get()).toEqual({ title: 'Old' })
    legacy
      .prepare(
        "INSERT INTO llm_request_usage(id,operation,model_id,started_at,status,usage_status) VALUES ('new','sentence_translation','fake',2,'completed','missing')"
      )
      .run()
  } finally {
    legacy.close()
  }
})
