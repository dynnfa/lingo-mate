import { resolve } from 'node:path'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { openDatabase } from '../../src/database/database'
import { SqliteConversationRepository } from '../../src/database/sqlite-conversation-repository'
import { SqliteTtsRepository } from '../../src/database/sqlite-tts-repository'
import type { SpeechInput } from '../../src/shared/speech'
import { ConversationModule } from '../../src/core/conversation/conversation-module'
import { TtsConversationSkill } from '../../src/core/speech/tts-conversation-skill'
import { joinSpeechPcm } from '../../src/core/speech/speech-audio'
import { SPEECH_IDENTITY } from '../../src/shared/speech'
import type { ConversationEvent } from '../../src/shared/conversation'
import { SpeechError } from '../../src/core/speech/speech-synthesizer'

function createRuntime(): { runtime: PythonAgentRuntime; resolveModel: ReturnType<typeof vi.fn> } {
  const child = new PythonAgentProcess({
    command: resolve(
      'agent-engine/.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    ),
    args: ['-I', '-m', 'lingo_agent']
  })
  const resolveModel = vi.fn(() => {
    throw new Error('No language model configured')
  })
  return { runtime: new PythonAgentRuntime(child, resolveModel), resolveModel }
}

it.each(['NOT_INSTALLED', 'TIMEOUT', 'INVALID_TIMELINE'] as const)(
  'shows a safe %s failure without producing an audio message',
  async (code) => {
    const db = openDatabase(':memory:')
    const repository = new SqliteConversationRepository(db)
    const { runtime, resolveModel } = createRuntime()
    const skill = new TtsConversationSkill(
      new SqliteTtsRepository(db),
      {
        synthesize: async () => {
          throw new SpeechError(code)
        }
      },
      runtime
    )
    const module = new ConversationModule(
      repository,
      runtime,
      undefined,
      new Map([['tts', skill]]),
      repository
    )
    const events: ConversationEvent[] = []
    try {
      const session = await module.createConversation()
      await module.runSkill(
        {
          requestId: randomUUID(),
          sessionId: session.sessionId,
          skillId: 'tts',
          arguments: { text: 'Hello', wordLanguage: 'en' }
        },
        (event) => {
          events.push(event)
        }
      )
      await vi.waitFor(() =>
        expect(events.at(-1)).toMatchObject({
          type: 'failed',
          error: { code: 'SPEECH_ERROR', speechCode: code }
        })
      )
      expect((await module.loadConversation(session.sessionId)).messages).toHaveLength(1)
      expect(resolveModel).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
      db.close()
    }
  }
)

it('rejects an empty direct /tts submission before model execution or persistence', async () => {
  const db = openDatabase(':memory:')
  const repository = new SqliteConversationRepository(db)
  const { runtime, resolveModel } = createRuntime()
  const module = new ConversationModule(repository, runtime)
  const session = await module.createConversation()
  await expect(
    module.sendMessage(
      { requestId: randomUUID(), sessionId: session.sessionId, text: '/tts' },
      () => {}
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(resolveModel).not.toHaveBeenCalled()
  expect((await module.loadConversation(session.sessionId)).messages).toEqual([])
  await runtime.dispose()
  db.close()
})

it('saves a speech reply and restores committed audio on retry without invoking a model or synthesizing again', async () => {
  const db = openDatabase(':memory:')
  const repository = new SqliteConversationRepository(db)
  const audioRepository = new SqliteTtsRepository(db)
  const synthesize = vi.fn(async (input: SpeechInput) => ({
    ...input,
    settings: { voice: 'af_bella' as const, speed: 1 },
    identity: SPEECH_IDENTITY.revision,
    audio: new Uint8Array(joinSpeechPcm([new Uint8Array(48000)])),
    durationSeconds: 1,
    words: [
      { index: 0, text: 'Hello', charStart: 0, charEnd: 5, startSeconds: 0.1, endSeconds: 0.8 }
    ]
  }))
  const { runtime, resolveModel } = createRuntime()
  const skill = new TtsConversationSkill(audioRepository, { synthesize }, runtime)
  const module = new ConversationModule(
    repository,
    runtime,
    undefined,
    new Map([['tts', skill]]),
    repository
  )
  const events: ConversationEvent[] = []
  const emit = (event: ConversationEvent): void => {
    events.push(event)
  }
  try {
    const session = await module.createConversation()
    const finish = vi
      .spyOn(repository, 'finishExecution')
      .mockRejectedValueOnce(new Error('temporary write failure'))
    const result = await module.sendMessage(
      { requestId: randomUUID(), sessionId: session.sessionId, text: '/tts Hello' },
      emit
    )
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('failed'))
    finish.mockRestore()
    const retry = new ConversationModule(
      repository,
      runtime,
      undefined,
      new Map([['tts', skill]]),
      repository
    )
    await retry.retryMessage(
      {
        requestId: randomUUID(),
        sessionId: session.sessionId,
        userMessageId: result.generation.userMessage.messageId
      },
      emit
    )
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('completed'))
    const loaded = await retry.loadConversation(session.sessionId)
    expect(loaded.messages[1]).toMatchObject({
      content: 'Hello',
      speech: { kind: 'tts', durationSeconds: 1 }
    })
    const restored = await audioRepository.loadConversationAudio({
      sessionId: session.sessionId,
      messageId: loaded.messages[1].messageId
    })
    expect(restored.text).toBe('Hello')
    expect(restored.audio).toEqual(joinSpeechPcm([new Uint8Array(48000)]))
    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(resolveModel).not.toHaveBeenCalled()
    expect((await repository.find(session.sessionId))?.title).toBe('Hello')
  } finally {
    await runtime.dispose()
    db.close()
  }
})
