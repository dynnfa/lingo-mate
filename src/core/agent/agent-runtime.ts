import type { ModelMessage, ModelStreamEvent } from '../llm/language-model'
import {
  agentSnapshotSchema,
  type VocabularyPracticeModelArgs,
  type VocabularyPracticeApplyArgs,
  type VocabularyPracticeCorrectArgs,
  type VocabularyPracticeFinishArgs,
  type VocabularyPracticeTurn,
  type VocabularyPracticeCompletion,
  type SentencePracticeTask,
  type SentencePracticePrepared,
  type SentencePracticeCompletion,
  type AgentBudget,
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

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  timeoutMs: 120_000,
  maxModelCalls: 3,
  maxToolCalls: 2,
  maxSteps: 16,
  maxInputChars: 32_768,
  maxOutputChars: 32_768
}
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
export interface AgentRuntime
  extends
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
  if (input.task === 'vocabulary-practice-review')
    return agentSnapshotSchema.parse({
      ...input,
      budget: {
        timeoutMs: 120_000,
        maxModelCalls: 8,
        maxToolCalls: 10,
        maxSteps: 18,
        maxInputChars: 65_536,
        maxOutputChars: 4096
      },
      allowedOperations: [
        'vocabulary-practice.prepare',
        'model.vocabulary-practice-review',
        'vocabulary-practice.apply',
        'vocabulary-practice.correct',
        'vocabulary-practice.finish'
      ]
    })
  if (input.task === 'sentence-practice-hints' || input.task === 'sentence-practice-review')
    return agentSnapshotSchema.parse({
      ...input,
      budget: {
        timeoutMs: 120_000,
        maxModelCalls: 1,
        maxToolCalls: 1,
        maxSteps: 2,
        maxInputChars: 65_536,
        maxOutputChars: 1024
      },
      allowedOperations: ['sentence-practice.prepare', `model.${input.task}`]
    })
  if (input.task === 'conversation-title')
    return agentSnapshotSchema.parse({
      ...input,
      budget: {
        timeoutMs: 120_000,
        maxModelCalls: 1,
        maxToolCalls: 0,
        maxSteps: 1,
        maxInputChars: 32_768,
        maxOutputChars: 80
      },
      allowedOperations: ['model.title']
    })
  if (input.task === 'explore-phrase' || input.task === 'explore-vocabulary')
    return agentSnapshotSchema.parse({
      ...input,
      budget: {
        timeoutMs: 180_000,
        maxModelCalls: 3,
        maxToolCalls: 1,
        maxSteps: 8,
        maxInputChars: 65_536,
        maxOutputChars: 32_768
      },
      allowedOperations:
        input.task === 'explore-phrase'
          ? ['explore-phrase.prepare', 'model.explore-phrase']
          : ['explore-vocabulary.prepare', 'model.explore-vocabulary']
    })
  if (input.task === 'synonym')
    return agentSnapshotSchema.parse({
      ...input,
      budget: {
        timeoutMs: 180_000,
        maxModelCalls: 1040,
        maxToolCalls: 1061,
        maxSteps: 2200,
        maxInputChars: 65_536,
        maxOutputChars: 524_288
      },
      allowedOperations: ['synonym.prepare', 'model.synonym', 'synonym.apply', 'synonym.finish']
    })
  if (input.task === 'vocabulary' || input.task === 'phrase')
    return agentSnapshotSchema.parse({
      ...input,
      budget: { ...DEFAULT_AGENT_BUDGET, timeoutMs: 180_000, maxModelCalls: 20, maxSteps: 32 },
      allowedOperations:
        input.task === 'phrase'
          ? ['phrase.prepare', 'model.phrase']
          : ['vocabulary.prepare', 'model.vocabulary']
    })
  let remaining = DEFAULT_AGENT_BUDGET.maxInputChars - 4096
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
    budget: { ...DEFAULT_AGENT_BUDGET },
    allowedOperations:
      input.task === 'tool-loop' ? ['model.decide', 'learning.lookup'] : ['model.reply']
  })
}
