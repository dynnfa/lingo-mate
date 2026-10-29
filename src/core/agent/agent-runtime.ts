import { getAgentTaskPolicy } from './agent-task-policy'
import type { ModelMessage, ModelStreamEvent } from '../llm/language-model'
import {
  agentSnapshotSchema,
  type SentencePrepared,
  type TtsCompletion,
  type VocabularyPracticeModelArgs,
  type VocabularyPracticeApplyArgs,
  type VocabularyPracticeCorrectArgs,
  type VocabularyPracticeFinishArgs,
  type VocabularyPracticeTurn,
  type VocabularyPracticeCompletion,
  type SentencePracticeTask,
  type SentencePracticePrepared,
  type SentencePracticeCompletion,
  type AgentErrorCode,
  type VocabularyPrepared,
  type VocabularyAnalysisReceipt,
  type VocabularyCompletion,
  type PhrasePrepared,
  type PhraseAnalysisReceipt,
  type PhraseCompletion,
  type SynonymPrepared,
  type SynonymTurn,
  type SynonymApplied,
  type SynonymFinished,
  type SynonymCompletion,
  type SynonymModelArgs,
  type SynonymApplyArgs,
  type SynonymFinishArgs,
  type AgentSnapshot,
  type ExplorePhrasePrepared,
  type ExplorePhraseReceipt,
  type ExplorePhraseCompletion,
  type ExplorePhraseModelArgs,
  type ExploreVocabularyPrepared,
  type ExploreVocabularyReceipt,
  type ExploreVocabularyCompletion,
  type ExploreVocabularyModelArgs
} from './agent-protocol'

export { DEFAULT_AGENT_BUDGET } from './agent-task-policy'
export interface AgentTask {
  task: AgentSnapshot['task']
  messages: ModelMessage[]
  outputLanguage: string
  targetLanguage: string
}
export interface AgentRunInput extends AgentTask {
  sessionId: string
  signal: AbortSignal
}
export interface VocabularyHostOperations {
  prepare(): VocabularyPrepared | Promise<VocabularyPrepared>
  analyze(
    args: { inputIndex: number; systemPrompt: string },
    signal: AbortSignal
  ): Promise<VocabularyAnalysisReceipt>
  verifyCompletion(result: VocabularyCompletion): void
}
export interface VocabularyAgentRunInput {
  outputLanguage: string
  targetLanguage: string
  signal: AbortSignal
}
export interface VocabularyAgentRuntime {
  runVocabulary(input: VocabularyAgentRunInput, host: VocabularyHostOperations): Promise<void>
}
export interface PhraseHostOperations {
  prepare(): PhrasePrepared | Promise<PhrasePrepared>
  analyze(
    args: { inputIndex: number; systemPrompt: string },
    signal: AbortSignal
  ): Promise<PhraseAnalysisReceipt>
  verifyCompletion(result: PhraseCompletion): void
}
export interface PhraseAgentRunInput {
  outputLanguage: string
  targetLanguage: string
  signal: AbortSignal
}
export interface PhraseAgentRuntime {
  runPhrase(input: PhraseAgentRunInput, host: PhraseHostOperations): Promise<void>
}
export interface SynonymHostOperations {
  prepare(): SynonymPrepared
  model(args: SynonymModelArgs, signal: AbortSignal, maxInputChars: number): Promise<SynonymTurn>
  apply(args: SynonymApplyArgs, signal: AbortSignal): SynonymApplied
  finish(args: SynonymFinishArgs): SynonymFinished
  verifyCompletion(result: SynonymCompletion): void
}
export interface SynonymAgentRunInput {
  outputLanguage: string
  targetLanguage: string
  signal: AbortSignal
}
export interface SynonymAgentRuntime {
  runSynonym(input: SynonymAgentRunInput, host: SynonymHostOperations): Promise<void>
}
export interface ExplorePhraseHostOperations {
  prepare(): ExplorePhrasePrepared
  model(
    args: ExplorePhraseModelArgs,
    signal: AbortSignal,
    maxInputChars: number
  ): Promise<ExplorePhraseReceipt>
  verifyCompletion(result: ExplorePhraseCompletion): void
}
export interface ExplorePhraseAgentRunInput {
  outputLanguage: string
  targetLanguage: string
  signal: AbortSignal
}
export interface ExplorePhraseAgentRuntime {
  runExplorePhrase(
    input: ExplorePhraseAgentRunInput,
    host: ExplorePhraseHostOperations
  ): Promise<void>
}
export interface ExploreVocabularyHostOperations {
  prepare(): ExploreVocabularyPrepared
  model(
    args: ExploreVocabularyModelArgs,
    signal: AbortSignal,
    maxInputChars: number
  ): Promise<ExploreVocabularyReceipt>
  verifyCompletion(result: ExploreVocabularyCompletion): void
}
export interface ExploreVocabularyAgentRunInput {
  outputLanguage: string
  targetLanguage: string
  signal: AbortSignal
}
export interface ExploreVocabularyAgentRuntime {
  runExploreVocabulary(
    input: ExploreVocabularyAgentRunInput,
    host: ExploreVocabularyHostOperations
  ): Promise<void>
}
export interface VocabularyPracticeHostOperations {
  prepare(): { inputChars: number }
  model(
    args: VocabularyPracticeModelArgs,
    signal: AbortSignal,
    maxInputChars: number
  ): Promise<VocabularyPracticeTurn>
  apply(args: VocabularyPracticeApplyArgs, signal: AbortSignal): { round: number; applied: true }
  correct(
    args: VocabularyPracticeCorrectArgs,
    signal: AbortSignal
  ): { round: number; applied: true }
  finish(args: VocabularyPracticeFinishArgs): VocabularyPracticeCompletion
  verifyCompletion(result: VocabularyPracticeCompletion): void
}
export interface VocabularyPracticeAgentRuntime {
  runVocabularyPractice(
    input: VocabularyAgentRunInput,
    host: VocabularyPracticeHostOperations
  ): Promise<void>
}
export interface SentencePracticeHostOperations {
  prepare(): SentencePracticePrepared
  model(
    args: { systemPrompt: string },
    signal: AbortSignal,
    maxInputChars: number
  ): Promise<SentencePracticeCompletion>
  verifyCompletion(result: SentencePracticeCompletion): void
}
export interface SentencePracticeAgentRuntime {
  runSentencePractice(
    input: {
      task: SentencePracticeTask
      outputLanguage: string
      targetLanguage: string
      signal: AbortSignal
    },
    host: SentencePracticeHostOperations
  ): Promise<void>
}
export interface TtsAgentRunInput {
  outputLanguage: string
  targetLanguage: string
  signal: AbortSignal
}
export interface TtsHostOperations {
  synthesize(signal: AbortSignal): Promise<TtsCompletion>
  verifyCompletion(result: TtsCompletion): void
}
export interface TtsAgentRuntime {
  runTts(input: TtsAgentRunInput, host: TtsHostOperations): Promise<void>
}
export interface SentenceHostOperations {
  prepare(): SentencePrepared
  model(
    args: { systemPrompt: string },
    signal: AbortSignal,
    maxInputChars: number
  ): Promise<SentencePracticeCompletion>
  verifyCompletion(result: SentencePracticeCompletion): void
}
export interface SentenceAgentRuntime {
  runSentence(input: VocabularyAgentRunInput, host: SentenceHostOperations): Promise<void>
}
export interface AgentRuntime
  extends
    SentenceAgentRuntime,
    TtsAgentRuntime,
    VocabularyPracticeAgentRuntime,
    SentencePracticeAgentRuntime,
    VocabularyAgentRuntime,
    PhraseAgentRuntime,
    SynonymAgentRuntime,
    ExplorePhraseAgentRuntime,
    ExploreVocabularyAgentRuntime {
  stream(input: AgentRunInput): AsyncIterable<ModelStreamEvent>
}
export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options)
    this.name = 'AgentRuntimeError'
  }
}

// Reserve space for the fixed host prompt/operation definitions. Persisted history
// is never edited; only this execution's copied context is trimmed.
export function createAgentSnapshot(input: AgentTask): AgentSnapshot {
  const policy = getAgentTaskPolicy(input.task)
  if (input.task !== 'conversation' && input.task !== 'tool-loop')
    return agentSnapshotSchema.parse({
      ...input,
      budget: policy.budget,
      allowedOperations: policy.allowedOperations
    })
  let remaining = policy.budget.maxInputChars - 4096
  const messages: ModelMessage[] = []
  for (const message of input.messages.slice(-100).reverse()) {
    if (remaining <= 0) break
    let start = Math.max(0, message.content.length - remaining)
    const first = message.content.charCodeAt(start)
    const previous = message.content.charCodeAt(start - 1)
    if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start++
    const content = message.content.slice(start)
    messages.unshift({ role: message.role, content })
    remaining -= content.length
  }
  return agentSnapshotSchema.parse({
    ...input,
    messages,
    budget: policy.budget,
    allowedOperations: policy.allowedOperations
  })
}
