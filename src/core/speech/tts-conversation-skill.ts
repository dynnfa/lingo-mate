import { AgentRuntimeError, type TtsAgentRuntime } from '../agent/agent-runtime'
import type {
  ConversationSkill,
  ConversationSkillRunInput,
  ConversationSkillRunResult
} from '../conversation/conversation-skill'
import type { ConversationSkillReport } from '../../shared/conversation'
import {
  isTtsReport,
  speechAudioSchema,
  type SpeechAudio,
  type SpeechInput
} from '../../shared/speech'
import type { TtsRepository } from './tts-repository'

export class TtsConversationSkill implements ConversationSkill {
  readonly skillId = 'tts' as const
  constructor(
    private readonly repository: TtsRepository,
    private readonly speech: {
      synthesize(input: SpeechInput, signal: AbortSignal): Promise<SpeechAudio>
    },
    private readonly runtime: TtsAgentRuntime
  ) {}

  async run(input: ConversationSkillRunInput): Promise<ConversationSkillRunResult> {
    if (!('text' in input.arguments)) throw new Error('Speech requires text')
    const text = input.arguments.text
    let audio: SpeechAudio | undefined
    let started = false
    let verified = false
    await input.onPhase('analyzing')
    await this.runtime.runTts(
      { outputLanguage: input.explanationLanguage, targetLanguage: 'en', signal: input.signal },
      {
        synthesize: async (signal) => {
          if (started) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
          started = true
          audio = speechAudioSchema.parse(
            await this.speech.synthesize(
              { requestId: input.requestId, text, language: 'en' },
              signal
            )
          )
          if (audio.text !== text || audio.requestId !== input.requestId)
            throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
          signal.throwIfAborted()
          return { completed: true }
        },
        verifyCompletion: (result) => {
          if (!audio || result.completed !== true || verified)
            throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
          verified = true
        }
      }
    )
    input.signal.throwIfAborted()
    if (!verified || !audio) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    await input.onPhase('committing')
    input.signal.throwIfAborted()
    const report = await this.repository.commit(input.executionId, audio)
    await input.onPhase('summarizing')
    return { outcome: 'completed', report }
  }

  feedback(report: ConversationSkillReport): string {
    if (!isTtsReport(report)) throw new Error('Report does not match speech')
    return report.text
  }
}
