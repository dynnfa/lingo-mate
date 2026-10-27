import {
  agentDecisionSchema,
  agentHostResultSchema,
  type AgentCallArgs,
  type AgentOperation,
  type AgentSnapshot
} from '../agent-protocol'
import { AgentRuntimeError } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter, AgentTestOperations } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'

export class ToolLoopTask implements AgentTaskAdapter {
  readonly task = 'tool-loop'
  private results: Array<{ entries: string[] }> = []
  private query?: string
  constructor(
    private readonly snapshot: AgentSnapshot,
    private readonly operations: AgentTestOperations
  ) {}
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    if (operation === 'model.decide') {
      if (
        Object.keys(args).some((key) => key !== 'results') ||
        JSON.stringify(args.results) !== JSON.stringify(this.results)
      )
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      return {
        kind: 'model',
        output: 'decision',
        execute: async (signal) => {
          const decision = agentDecisionSchema.parse(
            await this.operations.decide({
              messages: structuredClone(this.snapshot.messages),
              outputLanguage: this.snapshot.outputLanguage,
              targetLanguage: this.snapshot.targetLanguage,
              results: structuredClone(this.results),
              signal
            })
          )
          signal.throwIfAborted()
          if (decision.kind === 'tool') this.query = decision.query
          return decision
        }
      }
    }
    if (operation === 'learning.lookup') {
      if (
        Object.keys(args).some((key) => key !== 'query') ||
        !args.query ||
        args.query !== this.query
      )
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      const query = args.query
      this.query = undefined
      return {
        kind: 'tool',
        output: 'none',
        execute: async (signal) => {
          const result = agentHostResultSchema.parse(await this.operations.lookup(query, signal))
          signal.throwIfAborted()
          if (!('entries' in result)) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
          this.results.push(result)
          if (
            JSON.stringify(this.results).length +
              this.snapshot.messages.reduce((n, m) => n + m.content.length, 4096) >
            this.snapshot.budget.maxInputChars
          )
            throw new AgentRuntimeError('AGENT_LIMIT')
          return result
        }
      }
    }
    throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
  }
  verifyCompletion(frame: AgentSuccessFrame, streamedText: string): void {
    if (frame.type !== 'result' || frame.text !== streamedText)
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
  }
}
