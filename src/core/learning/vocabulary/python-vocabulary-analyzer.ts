import { AgentRuntimeError, type VocabularyAgentRuntime } from '../../agent/agent-runtime'
import type {
  AnalyzeVocabularyInput,
  VocabularyAnalysisResult,
  VocabularyAnalyzer,
  VocabularyModelAnalyzer
} from './vocabulary-analyzer'

// AI import retains its existing row/transaction workflow while sharing the
// Python-owned analysis Prompt. No provider request can bypass the graph.
export class PythonVocabularyAnalyzer implements VocabularyAnalyzer {
  constructor(
    private readonly runtime: VocabularyAgentRuntime,
    private readonly model: VocabularyModelAnalyzer
  ) {}

  async analyze(input: AnalyzeVocabularyInput): Promise<VocabularyAnalysisResult> {
    let prepared = false
    let claimed = false
    let verified = false
    let result: VocabularyAnalysisResult | undefined
    await this.runtime.runVocabulary(
      {
        outputLanguage: input.explanationLanguage,
        targetLanguage: input.wordLanguage,
        signal: input.signal
      },
      {
        prepare: () => {
          if (prepared) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
          prepared = true
          return { items: [{ inputIndex: 0, term: input.term, status: 'pending' }] }
        },
        analyze: async ({ inputIndex, systemPrompt }, signal) => {
          if (!prepared || claimed || inputIndex !== 0)
            throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
          claimed = true
          result = await this.model.analyze({ ...input, systemPrompt, signal })
          signal.throwIfAborted()
          return result.status === 'insert'
            ? { inputIndex: 0, status: 'staged' }
            : { inputIndex: 0, status: 'failed', code: 'UNRECOGNIZED' }
        },
        verifyCompletion: ({ completedIndices }) => {
          if (!result || completedIndices.length !== 1 || completedIndices[0] !== 0)
            throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
          verified = true
        }
      }
    )
    input.signal.throwIfAborted()
    if (!verified || !result) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    return result
  }
}
