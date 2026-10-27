import {
  explorePhraseModelArgsSchema,
  explorePhrasePreparedSchema,
  explorePhraseReceiptSchema,
  type AgentCallArgs,
  type AgentOperation,
  type AgentSnapshot
} from '../agent-protocol'
import { AgentRuntimeError, type ExplorePhraseHostOperations } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'

export class ExplorePhraseTask implements AgentTaskAdapter {
  readonly task = 'explore-phrase'
  constructor(
    private readonly snapshot: AgentSnapshot,
    private readonly host: ExplorePhraseHostOperations
  ) {}
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    if (operation === 'explore-phrase.prepare' && !Object.keys(args).length)
      return {
        kind: 'tool',
        output: 'json',
        execute: async () => explorePhrasePreparedSchema.parse(this.host.prepare())
      }
    if (operation === 'model.explore-phrase') {
      const parsed = explorePhraseModelArgsSchema.parse(args)
      return {
        kind: 'model',
        output: 'json',
        execute: async (signal) =>
          explorePhraseReceiptSchema.parse(
            await this.host.model(parsed, signal, this.snapshot.budget.maxInputChars)
          )
      }
    }
    throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
  }
  verifyCompletion(frame: AgentSuccessFrame): void {
    if (frame.type !== 'explore_phrase_result') throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.host.verifyCompletion(frame.result)
  }
}
