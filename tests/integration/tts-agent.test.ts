import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PythonAgentProcess } from '../../src/main/agent/python-agent-process'
import { PythonAgentRuntime } from '../../src/main/agent/python-agent-runtime'
import { randomUUID } from 'node:crypto'
import { TtsConversationSkill } from '../../src/core/speech/tts-conversation-skill'
import { joinSpeechPcm } from '../../src/core/speech/speech-audio'
import { SPEECH_IDENTITY, type SpeechInput } from '../../src/shared/speech'

it('runs one bound synthesis through Python without resolving a language model', async () => {
  const child = new PythonAgentProcess({
    command: resolve(
      'agent-engine/.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    ),
    args: ['-I', '-m', 'lingo_agent']
  })
  const resolveModel = vi.fn(() => {
    throw new Error('No model configured')
  })
  const runtime = new PythonAgentRuntime(child, resolveModel)
  const sent = vi.spyOn(child, 'send')
  const synthesize = vi.fn(async () => ({ completed: true as const }))
  const verifyCompletion = vi.fn()
  try {
    await runtime.runTts(
      { outputLanguage: 'zh-CN', targetLanguage: 'en', signal: new AbortController().signal },
      { synthesize, verifyCompletion }
    )
    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(verifyCompletion).toHaveBeenCalledWith({ completed: true })
    expect(resolveModel).not.toHaveBeenCalled()
    expect(sent.mock.calls.find(([frame]) => frame.type === 'run')?.[0]).toMatchObject({
      snapshot: { task: 'tts', budget: { maxModelCalls: 0, maxToolCalls: 1, maxSteps: 1 } }
    })
  } finally {
    await runtime.dispose()
  }
})

it.each(['premature', 'model', 'wrong-result', 'override', 'cross-run', 'failure'])(
  'rejects %s engine behavior without releasing a staged audio result',
  async (mode) => {
    const child = new PythonAgentProcess({
      command: resolve(
        'agent-engine/.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      ),
      args: ['-I', resolve('tests/integration/fixtures/agent/tts-fault-engine.py'), mode]
    })
    const resolveModel = vi.fn(() => {
      throw new Error('Model access forbidden')
    })
    const runtime = new PythonAgentRuntime(child, resolveModel)
    const commit = vi.fn()
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
    const skill = new TtsConversationSkill(
      { commit, loadConversationAudio: vi.fn() },
      { synthesize },
      runtime
    )
    try {
      await expect(
        skill.run({
          requestId: randomUUID(),
          executionId: randomUUID(),
          sessionId: randomUUID(),
          userMessageId: randomUUID(),
          arguments: { text: 'Hello', wordLanguage: 'en' },
          explanationLanguage: 'en',
          signal: new AbortController().signal,
          onPhase: () => {}
        })
      ).rejects.toMatchObject({ code: 'AGENT_PROTOCOL_ERROR' })
      expect(commit).not.toHaveBeenCalled()
      expect(resolveModel).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  }
)

it('cancels a pending host synthesis and ignores its late receipt without committing audio', async () => {
  const child = new PythonAgentProcess({
    command: resolve(
      'agent-engine/.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    ),
    args: ['-I', '-m', 'lingo_agent']
  })
  const runtime = new PythonAgentRuntime(child, () => {
    throw new Error('Model forbidden')
  })
  const controller = new AbortController()
  let signal: AbortSignal | undefined
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const commit = vi.fn()
  const skill = new TtsConversationSkill(
    { commit, loadConversationAudio: vi.fn() },
    {
      synthesize: async (input, abort) => {
        signal = abort
        await pending
        return {
          ...input,
          settings: { voice: 'af_bella', speed: 1 },
          identity: SPEECH_IDENTITY.revision,
          audio: new Uint8Array(joinSpeechPcm([new Uint8Array(48000)])),
          durationSeconds: 1,
          words: [
            {
              index: 0,
              text: 'Hello',
              charStart: 0,
              charEnd: 5,
              startSeconds: 0.1,
              endSeconds: 0.8
            }
          ]
        }
      }
    },
    runtime
  )
  const result = skill.run({
    requestId: randomUUID(),
    executionId: randomUUID(),
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    arguments: { text: 'Hello', wordLanguage: 'en' },
    explanationLanguage: 'en',
    signal: controller.signal,
    onPhase: () => {}
  })
  const rejected = expect(result).rejects.toBeDefined()
  try {
    await vi.waitFor(() => expect(signal).toBeDefined())
    controller.abort()
    await rejected
    expect(signal?.aborted).toBe(true)
    finish()
    await pending
    expect(commit).not.toHaveBeenCalled()
  } finally {
    finish()
    await runtime.dispose()
  }
})
