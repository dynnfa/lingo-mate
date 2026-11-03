import {
  agentReplyArgsSchema,
  sentencePreparedSchema,
  sentencePracticeCompletionSchema,
  type AgentCallArgs,
  type AgentOperation,
  type AgentSnapshot
} from '../agent-protocol'
import { AgentRuntimeError, type SentenceHostOperations } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'
export class SentenceTask implements AgentTaskAdapter {
  readonly task = 'sentence'
  private prepared = false
  private needsModel = false
  private started = false
  constructor(
    private readonly snapshot: AgentSnapshot,
    private readonly host: SentenceHostOperations
  ) {}
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    if (operation === 'sentence.prepare' && !Object.keys(args).length && !this.prepared) {
      this.prepared = true
      return {
        kind: 'tool',
        output: 'json',
        execute: async () => {
          const result = sentencePreparedSchema.parse(this.host.prepare())
          this.needsModel = !result.existing
          return result
        }
      }
    }
    if (operation === 'model.sentence' && this.prepared && this.needsModel && !this.started) {
      const parsed = agentReplyArgsSchema.parse(args)
      this.started = true
      return {
        kind: 'model',
        output: 'json',
        execute: async (signal) =>
          sentencePracticeCompletionSchema.parse(
            await this.host.model(parsed, signal, this.snapshot.budget.maxInputChars)
          )
      }
    }
    throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
  }
  verifyCompletion(frame: AgentSuccessFrame): void {
    if (frame.type !== 'sentence_result' || !this.prepared || (this.needsModel && !this.started))
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.host.verifyCompletion(frame.result)
  }
}
