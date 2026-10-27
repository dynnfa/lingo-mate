import {
  exploreVocabularyModelArgsSchema,
  exploreVocabularyPreparedSchema,
  exploreVocabularyReceiptSchema,
  type AgentCallArgs,
  type AgentOperation,
  type AgentSnapshot
} from '../agent-protocol'
import { AgentRuntimeError, type ExploreVocabularyHostOperations } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'

export class ExploreVocabularyTask implements AgentTaskAdapter {
  readonly task = 'explore-vocabulary'
  constructor(
    private readonly snapshot: AgentSnapshot,
    private readonly host: ExploreVocabularyHostOperations
  ) {}
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    if (operation === 'explore-vocabulary.prepare' && !Object.keys(args).length)
      return {
        kind: 'tool',
        output: 'json',
        execute: async () => exploreVocabularyPreparedSchema.parse(this.host.prepare())
      }
    if (operation === 'model.explore-vocabulary') {
      const parsed = exploreVocabularyModelArgsSchema.parse(args)
      return {
        kind: 'model',
        output: 'json',
        execute: async (signal) =>
          exploreVocabularyReceiptSchema.parse(
            await this.host.model(parsed, signal, this.snapshot.budget.maxInputChars)
          )
      }
    }
    throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
  }
  verifyCompletion(frame: AgentSuccessFrame): void {
    if (frame.type !== 'explore_vocabulary_result')
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.host.verifyCompletion(frame.result)
  }
}
