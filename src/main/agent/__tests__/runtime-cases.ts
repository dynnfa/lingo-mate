import type { VocabularyAgentRunInput } from '../../../core/agent/agent-runtime'
import type { AgentPayload } from '../python-agent-process'
import type { PythonAgentRuntime } from '../python-agent-runtime'
import type { AgentSnapshot } from '../../../core/agent/agent-protocol'
import type { AgentSuccessFrame } from '../../../core/agent/agent-task-policy'

const input = (): VocabularyAgentRunInput => ({
  outputLanguage: 'en',
  targetLanguage: 'en',
  signal: new AbortController().signal
})
type SuccessPayload = Extract<AgentPayload, { type: AgentSuccessFrame['type'] }>
interface RuntimeCase {
  task: AgentSnapshot['task']
  success: SuccessPayload
  run(runtime: PythonAgentRuntime, verify: (result: unknown) => void): Promise<void>
}
export const runtimeCases: RuntimeCase[] = [
  {
    task: 'tts',
    success: { type: 'tts_result', runId: '', result: { completed: true } },
    run: (runtime, verifyCompletion) =>
      runtime.runTts(input(), { synthesize: async () => ({ completed: true }), verifyCompletion })
  },
  {
    task: 'vocabulary',
    success: { type: 'vocabulary_result', runId: '', result: { completedIndices: [] } },
    run: (runtime, verifyCompletion) =>
      runtime.runVocabulary(input(), {
        prepare: () => ({ items: [{ inputIndex: 0, term: 'word', status: 'existing' }] }),
        analyze: async () => ({ inputIndex: 0, status: 'staged' }),
        verifyCompletion
      })
  },
  {
    task: 'phrase',
    success: { type: 'phrase_result', runId: '', result: { completedIndices: [] } },
    run: (runtime, verifyCompletion) =>
      runtime.runPhrase(input(), {
        prepare: () => ({ items: [{ inputIndex: 0, phrase: 'a phrase', status: 'existing' }] }),
        analyze: async () => ({ inputIndex: 0, status: 'staged' }),
        verifyCompletion
      })
  },
  {
    task: 'synonym',
    success: { type: 'synonym_result', runId: '', result: { completedIndices: [] } },
    run: (runtime, verifyCompletion) =>
      runtime.runSynonym(input(), {
        prepare: () => ({ items: [{ inputIndex: 0, status: 'resolved' }] }),
        model: async () => {
          throw new Error('Unexpected model')
        },
        apply: () => {
          throw new Error('Unexpected apply')
        },
        finish: () => {
          throw new Error('Unexpected finish')
        },
        verifyCompletion
      })
  },
  ...(['explore-phrase', 'explore-vocabulary'] as const).map((task): RuntimeCase => ({
    task,
    success: {
      type: task === 'explore-phrase' ? 'explore_phrase_result' : 'explore_vocabulary_result',
      runId: '',
      result: { attempts: 1, acceptedCount: 10 }
    },
    run: (runtime, verifyCompletion) => {
      const host = {
        prepare: () => ({ inputChars: 0, acceptedCount: 0 as const }),
        model: async () => {
          throw new Error('Unexpected model')
        },
        verifyCompletion
      }
      return task === 'explore-phrase'
        ? runtime.runExplorePhrase(input(), host)
        : runtime.runExploreVocabulary(input(), host)
    }
  })),
  ...(['sentence-practice-hints', 'sentence-practice-review'] as const).map(
    (task): RuntimeCase => ({
      task,
      success: { type: 'sentence_practice_result', runId: '', result: { completed: true } },
      run: (runtime, verifyCompletion) =>
        runtime.runSentencePractice(
          { ...input(), task },
          {
            prepare: () => ({ inputChars: 0 }),
            model: async () => ({ completed: true }),
            verifyCompletion
          }
        )
    })
  ),
  {
    task: 'vocabulary-practice-review',
    success: {
      type: 'vocabulary_practice_result',
      runId: '',
      result: { completed: true, rounds: 1 }
    },
    run: (runtime, verifyCompletion) =>
      runtime.runVocabularyPractice(input(), {
        prepare: () => ({ inputChars: 0 }),
        model: async () => {
          throw new Error('Unexpected model')
        },
        apply: () => {
          throw new Error('Unexpected apply')
        },
        correct: () => {
          throw new Error('Unexpected correct')
        },
        finish: () => {
          throw new Error('Unexpected finish')
        },
        verifyCompletion
      })
  },
  ...(['conversation', 'conversation-title', 'tool-loop'] as const).map((task): RuntimeCase => ({
    task,
    success: { type: 'result', runId: '', text: '' },
    run: async (runtime) => {
      for await (const event of runtime.stream({
        ...input(),
        task,
        sessionId: '',
        messages: [{ role: 'user', content: 'word' }]
      }))
        void event
    }
  }))
]
