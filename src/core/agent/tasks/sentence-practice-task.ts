import {
  agentReplyArgsSchema,
  sentencePracticePreparedSchema,
  sentencePracticeCompletionSchema,
  type AgentCallArgs,
  type AgentOperation,
  type AgentSnapshot,
  type SentencePracticeTask as SentenceTask
} from '../agent-protocol'
import { AgentRuntimeError, type SentencePracticeHostOperations } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'

export class SentencePracticeTask implements AgentTaskAdapter {
  private prepared = false
  private modelStarted = false
  constructor(
    readonly task: SentenceTask,
    private readonly snapshot: AgentSnapshot,
    private readonly host: SentencePracticeHostOperations
  ) {}
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    if (operation === 'sentence-practice.prepare' && !Object.keys(args).length) {
      if (this.prepared) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      this.prepared = true
      return {
        kind: 'tool',
        output: 'json',
        execute: async () => sentencePracticePreparedSchema.parse(this.host.prepare())
      }
    }
    if (operation === `model.${this.task}`) {
      if (!this.prepared || this.modelStarted) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      const parsed = agentReplyArgsSchema.parse(args)
      this.modelStarted = true
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
    if (frame.type !== 'sentence_practice_result')
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.host.verifyCompletion(frame.result)
  }
}
