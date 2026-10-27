import {
  synonymModelArgsSchema,
  synonymApplyArgsSchema,
  synonymFinishArgsSchema,
  synonymPreparedSchema,
  synonymTurnSchema,
  synonymAppliedSchema,
  synonymFinishedSchema,
  type AgentCallArgs,
  type AgentOperation,
  type AgentSnapshot
} from '../agent-protocol'
import { AgentRuntimeError, type SynonymHostOperations } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'

export class SynonymTask implements AgentTaskAdapter {
  readonly task = 'synonym'
  constructor(
    private readonly snapshot: AgentSnapshot,
    private readonly host: SynonymHostOperations
  ) {}
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    switch (operation) {
      case 'synonym.prepare':
        if (Object.keys(args).length) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        return {
          kind: 'tool',
          output: 'json',
          execute: async () => synonymPreparedSchema.parse(this.host.prepare())
        }
      case 'model.synonym': {
        const parsed = synonymModelArgsSchema.parse(args)
        return {
          kind: 'model',
          output: 'json',
          execute: async (signal) => {
            const turn = synonymTurnSchema.parse(
              await this.host.model(parsed, signal, this.snapshot.budget.maxInputChars)
            )
            if (turn.inputChars > this.snapshot.budget.maxInputChars)
              throw new AgentRuntimeError('AGENT_LIMIT')
            return turn
          }
        }
      }
      case 'synonym.apply': {
        const parsed = synonymApplyArgsSchema.parse(args)
        return {
          kind: 'tool',
          output: 'json',
          execute: async (signal) => synonymAppliedSchema.parse(this.host.apply(parsed, signal))
        }
      }
      case 'synonym.finish': {
        const parsed = synonymFinishArgsSchema.parse(args)
        return {
          kind: 'tool',
          output: 'json',
          execute: async () => synonymFinishedSchema.parse(this.host.finish(parsed))
        }
      }
      default:
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    }
  }
  verifyCompletion(frame: AgentSuccessFrame): void {
    if (frame.type !== 'synonym_result') throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.host.verifyCompletion(frame.result)
  }
}
