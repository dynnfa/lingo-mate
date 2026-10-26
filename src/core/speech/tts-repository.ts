import type { ConversationAudioInput, SpeechAudio, TtsReport } from '../../shared/speech'

export interface TtsRepository {
  commit(executionId: string, audio: SpeechAudio): Promise<TtsReport>
  loadConversationAudio(input: ConversationAudioInput): Promise<SpeechAudio>
}
