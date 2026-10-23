import { AgentRuntimeError, type SentencePracticeAgentRuntime } from '../../agent/agent-runtime'
import type { SentencePracticeTask } from '../../agent/agent-protocol'
import type {
  SentenceHintGenerator,
  SentencePracticeReviewer,
  SentencePracticeHintModel,
  SentencePracticeReviewModel
} from './sentence-practice-models'

// Each operation owns its bound input and staged result. Only size/receipt data
// crosses the Python boundary; results are released after graph verification.
async function runPractice<T>(
  runtime: SentencePracticeAgentRuntime,
  task: SentencePracticeTask,
  input: { explanationLanguage: string; practiceLanguage: string; signal: AbortSignal },
  payload: unknown,
  model: (systemPrompt: string, signal: AbortSignal) => Promise<T>
): Promise<T> {
  let prepared = false
  let started = false
  let verified = false
  let staged: T | undefined
  const inputChars = JSON.stringify(payload).length
  input.signal.throwIfAborted()
  await runtime.runSentencePractice(
    {
      task,
      outputLanguage: input.explanationLanguage,
      targetLanguage: input.practiceLanguage,
      signal: input.signal
    },
    {
      prepare: () => {
        if (prepared) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        if (inputChars > 65_536) throw new AgentRuntimeError('AGENT_LIMIT')
        prepared = true
        return { inputChars }
      },
      model: async ({ systemPrompt }, signal, maxInputChars) => {
        input.signal.throwIfAborted()
        signal.throwIfAborted()
        if (!prepared || started) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        if (systemPrompt.length > 4096 || systemPrompt.length + inputChars > maxInputChars)
          throw new AgentRuntimeError('AGENT_LIMIT')
        started = true
        const result = await model(systemPrompt, signal)
        input.signal.throwIfAborted()
        signal.throwIfAborted()
        staged = result
        return { completed: true }
      },
      verifyCompletion: (result) => {
        if (!result.completed || staged === undefined || verified)
          throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        input.signal.throwIfAborted()
        verified = true
      }
    }
  )
  input.signal.throwIfAborted()
  if (!verified || staged === undefined) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
  return staged
}

export class AgentSentencePracticeHintGenerator implements SentenceHintGenerator {
  constructor(
    private readonly runtime: SentencePracticeAgentRuntime,
    private readonly model: SentencePracticeHintModel
  ) {}

  generate(
    input: Parameters<SentenceHintGenerator['generate']>[0]
  ): ReturnType<SentenceHintGenerator['generate']> {
    const bound = { ...input, entries: structuredClone(input.entries) }
    return runPractice(
      this.runtime,
      'sentence-practice-hints',
      bound,
      { entries: bound.entries },
      (systemPrompt, signal) => this.model.generate({ ...bound, systemPrompt, signal })
    )
  }
}

export class AgentSentencePracticeReviewer implements SentencePracticeReviewer {
  constructor(
    private readonly runtime: SentencePracticeAgentRuntime,
    private readonly model: SentencePracticeReviewModel
  ) {}

  review(
    input: Parameters<SentencePracticeReviewer['review']>[0]
  ): ReturnType<SentencePracticeReviewer['review']> {
    const bound = {
      ...input,
      entries: structuredClone(input.entries),
      hints: structuredClone(input.hints)
    }
    return runPractice(
      this.runtime,
      'sentence-practice-review',
      bound,
      { entries: bound.entries, hints: bound.hints, answer: bound.answer },
      (systemPrompt, signal) => this.model.review({ ...bound, systemPrompt, signal })
    )
  }
}
