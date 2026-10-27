import type { AgentBudget, AgentFrame, AgentOperation, AgentSnapshot } from './agent-protocol'

export type AgentSuccessFrame = Extract<
  AgentFrame,
  {
    type:
      | 'result'
      | 'vocabulary_result'
      | 'phrase_result'
      | 'synonym_result'
      | 'explore_phrase_result'
      | 'explore_vocabulary_result'
      | 'sentence_practice_result'
      | 'vocabulary_practice_result'
      | 'tts_result'
  }
>
export interface AgentTaskPolicy {
  readonly budget: Readonly<AgentSnapshot['budget']>
  readonly allowedOperations: readonly AgentOperation[]
  readonly concurrency: { readonly max: number; readonly operation?: AgentOperation }
  readonly events: 'stream' | 'none'
  readonly successFrame: AgentSuccessFrame['type']
}

export const DEFAULT_AGENT_BUDGET: Readonly<AgentBudget> = Object.freeze({
  timeoutMs: 120_000,
  maxModelCalls: 3,
  maxToolCalls: 2,
  maxSteps: 16,
  maxInputChars: 32_768,
  maxOutputChars: 32_768
})

const policies = {
  conversation: {
    budget: DEFAULT_AGENT_BUDGET,
    allowedOperations: ['model.reply'],
    concurrency: { max: 1 },
    events: 'stream',
    successFrame: 'result'
  },
  'conversation-title': {
    budget: {
      ...DEFAULT_AGENT_BUDGET,
      maxModelCalls: 1,
      maxToolCalls: 0,
      maxSteps: 1,
      maxOutputChars: 80
    },
    allowedOperations: ['model.title'],
    concurrency: { max: 1 },
    events: 'stream',
    successFrame: 'result'
  },
  'tool-loop': {
    budget: DEFAULT_AGENT_BUDGET,
    allowedOperations: ['model.decide', 'learning.lookup'],
    concurrency: { max: 1 },
    events: 'stream',
    successFrame: 'result'
  },
  vocabulary: {
    budget: { ...DEFAULT_AGENT_BUDGET, timeoutMs: 180_000, maxModelCalls: 20, maxSteps: 32 },
    allowedOperations: ['vocabulary.prepare', 'model.vocabulary'],
    concurrency: { max: 2, operation: 'model.vocabulary' },
    events: 'none',
    successFrame: 'vocabulary_result'
  },
  phrase: {
    budget: { ...DEFAULT_AGENT_BUDGET, timeoutMs: 180_000, maxModelCalls: 20, maxSteps: 32 },
    allowedOperations: ['phrase.prepare', 'model.phrase'],
    concurrency: { max: 2, operation: 'model.phrase' },
    events: 'none',
    successFrame: 'phrase_result'
  },
  synonym: {
    budget: {
      timeoutMs: 180_000,
      maxModelCalls: 1040,
      maxToolCalls: 1061,
      maxSteps: 2200,
      maxInputChars: 65_536,
      maxOutputChars: 524_288
    },
    allowedOperations: ['synonym.prepare', 'model.synonym', 'synonym.apply', 'synonym.finish'],
    concurrency: { max: 1 },
    events: 'none',
    successFrame: 'synonym_result'
  },
  'explore-phrase': {
    budget: {
      timeoutMs: 180_000,
      maxModelCalls: 3,
      maxToolCalls: 1,
      maxSteps: 8,
      maxInputChars: 65_536,
      maxOutputChars: 32_768
    },
    allowedOperations: ['explore-phrase.prepare', 'model.explore-phrase'],
    concurrency: { max: 1 },
    events: 'none',
    successFrame: 'explore_phrase_result'
  },
  'explore-vocabulary': {
    budget: {
      timeoutMs: 180_000,
      maxModelCalls: 3,
      maxToolCalls: 1,
      maxSteps: 8,
      maxInputChars: 65_536,
      maxOutputChars: 32_768
    },
    allowedOperations: ['explore-vocabulary.prepare', 'model.explore-vocabulary'],
    concurrency: { max: 1 },
    events: 'none',
    successFrame: 'explore_vocabulary_result'
  },
  'sentence-practice-hints': {
    budget: {
      timeoutMs: 120_000,
      maxModelCalls: 1,
      maxToolCalls: 1,
      maxSteps: 2,
      maxInputChars: 65_536,
      maxOutputChars: 1024
    },
    allowedOperations: ['sentence-practice.prepare', 'model.sentence-practice-hints'],
    concurrency: { max: 1 },
    events: 'none',
    successFrame: 'sentence_practice_result'
  },
  'sentence-practice-review': {
    budget: {
      timeoutMs: 120_000,
      maxModelCalls: 1,
      maxToolCalls: 1,
      maxSteps: 2,
      maxInputChars: 65_536,
      maxOutputChars: 1024
    },
    allowedOperations: ['sentence-practice.prepare', 'model.sentence-practice-review'],
    concurrency: { max: 1 },
    events: 'none',
    successFrame: 'sentence_practice_result'
  },
  'vocabulary-practice-review': {
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
    ],
    concurrency: { max: 1 },
    events: 'none',
    successFrame: 'vocabulary_practice_result'
  },
  tts: {
    budget: {
      timeoutMs: 180_000,
      maxModelCalls: 0,
      maxToolCalls: 1,
      maxSteps: 1,
      maxInputChars: 4096,
      maxOutputChars: 1024
    },
    allowedOperations: ['tts.synthesize'],
    concurrency: { max: 1 },
    events: 'none',
    successFrame: 'tts_result'
  }
} as const satisfies Record<AgentSnapshot['task'], AgentTaskPolicy>

// No caller receives mutable references to the trusted policy table.
export function getAgentTaskPolicy(task: AgentSnapshot['task']): AgentTaskPolicy {
  return structuredClone(policies[task])
}
const successTypes: ReadonlySet<string> = new Set(
  Object.values(policies).map((policy) => policy.successFrame)
)
export function isAgentSuccessFrame(frame: AgentFrame): frame is AgentSuccessFrame {
  return successTypes.has(frame.type)
}
