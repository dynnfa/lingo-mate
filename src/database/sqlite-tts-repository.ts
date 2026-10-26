import type Database from 'better-sqlite3'
import {
  speechAudioSchema,
  ttsReportSchema,
  type ConversationAudioInput,
  type SpeechAudio,
  type TtsReport
} from '../shared/speech'
import type { TtsRepository } from '../core/speech/tts-repository'
import { SpeechError } from '../core/speech/speech-synthesizer'
import { readSpeechWav } from '../core/speech/speech-audio'

export class SqliteTtsRepository implements TtsRepository {
  constructor(private readonly database: Database.Database) {}

  async commit(executionId: string, raw: SpeechAudio): Promise<TtsReport> {
    const audio = speechAudioSchema.parse(raw)
    const report = ttsReportSchema.parse({
      skillId: 'tts',
      text: audio.text,
      speech: { kind: 'tts', durationSeconds: audio.durationSeconds, words: audio.words }
    })
    const { audio: bytes, ...metadata } = audio
    try {
      this.database.transaction(() => {
        const result = this.database
          .prepare(
            `UPDATE conversation_skill_executions SET batch_json = ?, phase = 'summarizing' WHERE id = ? AND skill_id = 'tts' AND batch_json IS NULL AND json_extract(arguments_json, '$.text') = ?`
          )
          .run(JSON.stringify(report), executionId, audio.text)
        if (result.changes !== 1) throw new Error('Speech execution does not match')
        this.database
          .prepare(
            'INSERT INTO conversation_speech_assets (execution_id, metadata_json, audio) VALUES (?, ?, ?)'
          )
          .run(executionId, JSON.stringify(metadata), Buffer.from(bytes))
      })()
      return report
    } catch (cause) {
      throw new SpeechError('STORAGE_FAILED', { cause })
    }
  }

  async loadConversationAudio(input: ConversationAudioInput): Promise<SpeechAudio> {
    try {
      const row = this.database
        .prepare(
          `SELECT a.metadata_json, a.audio, m.content FROM conversation_speech_assets a JOIN conversation_skill_executions e ON e.id = a.execution_id JOIN conversation_messages m ON m.id = e.assistant_message_id AND m.session_id = e.session_id WHERE e.session_id = ? AND m.id = ? AND m.role = 'assistant' AND e.skill_id = 'tts' AND e.phase = 'completed'`
        )
        .get(input.sessionId, input.messageId) as
        { metadata_json: string; audio: Uint8Array; content: string } | undefined
      if (!row) throw new SpeechError('AUDIO_NOT_FOUND')
      const audio = speechAudioSchema.parse({
        ...JSON.parse(row.metadata_json),
        audio: new Uint8Array(row.audio)
      })
      const wav = readSpeechWav(audio.audio)
      if (audio.text !== row.content || Math.abs(wav.seconds - audio.durationSeconds) > 1 / 24000)
        throw new SpeechError('INVALID_AUDIO')
      return audio
    } catch (cause) {
      if (cause instanceof SpeechError) throw cause
      throw new SpeechError('INVALID_AUDIO', { cause })
    }
  }
}
