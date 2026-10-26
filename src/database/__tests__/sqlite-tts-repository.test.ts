import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { SqliteConversationRepository } from '../sqlite-conversation-repository'
import { SqliteTtsRepository } from '../sqlite-tts-repository'
import { joinSpeechPcm } from '../../core/speech/speech-audio'
import { SPEECH_IDENTITY, type SpeechAudio } from '../../shared/speech'
import Database from 'better-sqlite3'
import { MIGRATIONS, migrateDatabase } from '../migrations'

it('upgrades v11 while preserving existing skill invocations and conversation messages', async () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 11)) migration.up(db)
    db.pragma('user_version = 11')
    const repository = new SqliteConversationRepository(db)
    const sessionId = randomUUID(),
      userId = randomUUID(),
      executionId = randomUUID()
    const now = new Date().toISOString()
    await repository.createExecution(
      {
        id: executionId,
        sessionId,
        userMessageId: userId,
        skillId: 'vocabulary',
        arguments: { text: 'Hello', wordLanguage: 'en' },
        explanationLanguage: 'en',
        phase: 'started',
        createdAt: now,
        updatedAt: now
      },
      { id: userId, sessionId, role: 'user', content: '/vocabulary Hello', createdAt: now },
      { id: sessionId, title: 'Existing', createdAt: now, updatedAt: now }
    )
    migrateDatabase(db)
    migrateDatabase(db)
    expect((await repository.findExecutionByUserMessage(sessionId, userId))?.id).toBe(executionId)
    expect((await repository.history(sessionId))[0].content).toBe('/vocabulary Hello')
    expect((await repository.find(sessionId))?.title).toBe('Existing')
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally {
    db.close()
  }
})

it('preserves v12 speech assets while expanding the audio byte limit to 24 MiB', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 12)) migration.up(db)
    db.pragma('user_version = 12')
    db.exec(`
      INSERT INTO conversations (id, title, created_at, updated_at)
        VALUES ('session', 'Hello', '2026-10-26', '2026-10-26');
      INSERT INTO conversation_messages (id, session_id, role, content, created_at)
        VALUES ('user', 'session', 'user', '/tts Hello', '2026-10-26');
      INSERT INTO conversation_skill_executions
        (id, session_id, user_message_id, skill_id, arguments_json,
         explanation_language, phase, created_at, updated_at)
        VALUES ('execution', 'session', 'user', 'tts', '{"text":"Hello"}',
                'en', 'summarizing', '2026-10-26', '2026-10-26');
    `)
    const bytes = Buffer.from(joinSpeechPcm([new Uint8Array(48000)]))
    const metadata = JSON.stringify({ text: 'Hello', durationSeconds: 1 })
    db.prepare('INSERT INTO conversation_speech_assets VALUES (?, ?, ?)').run(
      'execution',
      metadata,
      bytes
    )
    migrateDatabase(db)
    migrateDatabase(db)
    expect(db.prepare('SELECT * FROM conversation_speech_assets').get()).toEqual({
      execution_id: 'execution',
      metadata_json: metadata,
      audio: bytes
    })
    const resize = db.prepare('UPDATE conversation_speech_assets SET audio = zeroblob(?)')
    expect(() => resize.run(24 * 1024 * 1024)).not.toThrow()
    expect(() => resize.run(24 * 1024 * 1024 + 1)).toThrow(/CHECK constraint failed/)
    expect(() => db.exec("UPDATE conversation_speech_assets SET execution_id = 'missing'")).toThrow(
      /FOREIGN KEY constraint failed/
    )
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally {
    db.close()
  }
})

it.each([1, 360])(
  'keeps %i-second audio and its recovery report atomic, restores them after reopening, and rejects unrelated or corrupt audio',
  async (seconds) => {
    const directory = await mkdtemp(join(tmpdir(), 'lingo-tts-'))
    const path = join(directory, 'test.sqlite')
    let db = openDatabase(path)
    try {
      let conversations = new SqliteConversationRepository(db)
      let speech = new SqliteTtsRepository(db)
      const sessionId = randomUUID(),
        executionId = randomUUID(),
        userId = randomUUID(),
        messageId = randomUUID()
      const now = new Date().toISOString()
      await conversations.createExecution(
        {
          id: executionId,
          sessionId,
          userMessageId: userId,
          skillId: 'tts',
          arguments: { text: 'Hello', wordLanguage: 'en' },
          explanationLanguage: 'en',
          phase: 'started',
          createdAt: now,
          updatedAt: now
        },
        { id: userId, sessionId, role: 'user', content: '/tts Hello', createdAt: now },
        { id: sessionId, title: 'Hello', createdAt: now, updatedAt: now }
      )
      const audio: SpeechAudio = {
        requestId: randomUUID(),
        text: 'Hello',
        language: 'en',
        identity: SPEECH_IDENTITY.revision,
        settings: { voice: 'af_bella', speed: 1 },
        audio: new Uint8Array(joinSpeechPcm([new Uint8Array(seconds * 48000)])),
        durationSeconds: seconds,
        words: [
          { index: 0, text: 'Hello', charStart: 0, charEnd: 5, startSeconds: 0.1, endSeconds: 0.8 }
        ]
      }
      db.exec(
        "CREATE TRIGGER fail_audio BEFORE INSERT ON conversation_speech_assets BEGIN SELECT RAISE(ABORT, 'test failure'); END"
      )
      await expect(speech.commit(executionId, audio)).rejects.toMatchObject({
        code: 'STORAGE_FAILED'
      })
      expect(
        (await conversations.findExecutionByUserMessage(sessionId, userId))?.batch
      ).toBeUndefined()
      db.exec('DROP TRIGGER fail_audio')
      const report = await speech.commit(executionId, audio)
      await conversations.finishExecution(executionId, 'completed', {
        id: messageId,
        sessionId,
        role: 'assistant',
        content: 'Hello',
        speech: report.speech,
        createdAt: now
      })
      db.close()
      db = openDatabase(path)
      conversations = new SqliteConversationRepository(db)
      speech = new SqliteTtsRepository(db)
      expect((await conversations.history(sessionId))[1].speech).toEqual(report.speech)
      const restored = await speech.loadConversationAudio({ sessionId, messageId })
      const { audio: restoredBytes, ...restoredMetadata } = restored
      const { audio: expectedBytes, ...expectedMetadata } = audio
      expect(restoredMetadata).toEqual(expectedMetadata)
      expect(Buffer.from(restoredBytes).equals(expectedBytes)).toBe(true)
      await expect(
        speech.loadConversationAudio({ sessionId: randomUUID(), messageId })
      ).rejects.toMatchObject({ code: 'AUDIO_NOT_FOUND' })
      await expect(
        speech.loadConversationAudio({ sessionId, messageId: userId })
      ).rejects.toMatchObject({ code: 'AUDIO_NOT_FOUND' })
      db.prepare('UPDATE conversation_speech_assets SET audio = ?').run(Buffer.alloc(48))
      await expect(speech.loadConversationAudio({ sessionId, messageId })).rejects.toMatchObject({
        code: 'INVALID_AUDIO'
      })
    } finally {
      db.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
