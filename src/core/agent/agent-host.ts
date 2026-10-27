import { ZodError } from 'zod'
import type { ModelStreamEvent } from '../llm/language-model'
import {
  agentCallArgsSchema,
  type AgentCallArgs,
  type AgentHostResult,
  type AgentOperation,
  type AgentSnapshot
} from './agent-protocol'
import { AgentRuntimeError } from './agent-runtime'
import type { AgentTaskBinding } from './agent-task'
export type { AgentTestOperations } from './agent-task'

export class AgentHost {
  private readonly calls = new Set<string>()
  private modelCalls = 0
  private toolCalls = 0
  private outputChars = 0
  private readonly snapshot: AgentSnapshot
  constructor(
    snapshot: AgentSnapshot,
    private readonly binding: AgentTaskBinding
  ) {
    if (snapshot.task !== binding.task || snapshot.task !== binding.adapter.task)
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.snapshot = structuredClone(snapshot)
  }

  async call(
    callId: string,
    operation: AgentOperation,
    rawArgs: AgentCallArgs,
    emit: (event: ModelStreamEvent) => void | Promise<void>,
    signal: AbortSignal
  ): Promise<AgentHostResult> {
    signal.throwIfAborted()
    if (
      !this.binding.policy.allowedOperations.includes(operation) ||
      !this.snapshot.allowedOperations.some((allowed) => allowed === operation) ||
      this.calls.has(callId)
    )
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.calls.add(callId)
    try {
      const args = agentCallArgsSchema.parse(rawArgs)
      if (this.calls.size > this.snapshot.budget.maxSteps)
        throw new AgentRuntimeError('AGENT_LIMIT')
      const plan = this.binding.adapter.prepareCall(operation, args)
      // Reserve before awaiting: two concurrent analyses cannot spend the same
      // remaining model call. Task validation precedes budget reservation.
      if (plan.kind === 'model') {
        if (++this.modelCalls > this.snapshot.budget.maxModelCalls)
          throw new AgentRuntimeError('AGENT_LIMIT')
      } else if (++this.toolCalls > this.snapshot.budget.maxToolCalls)
        throw new AgentRuntimeError('AGENT_LIMIT')
      signal.throwIfAborted()
      const result = await plan.execute(signal, async (event) => {
        signal.throwIfAborted()
        this.countOutput(event.delta.length)
        await emit(event)
        signal.throwIfAborted()
      })
      signal.throwIfAborted()
      if (plan.output === 'json') this.countOutput(JSON.stringify(result).length)
      else if (plan.output === 'decision' && 'kind' in result && result.kind === 'final')
        this.countOutput(result.text.length)
      return result
    } catch (cause) {
      if (cause instanceof ZodError) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR', { cause })
      throw cause
    }
  }
  private countOutput(chars: number): void {
    this.outputChars += chars
    if (this.outputChars > this.snapshot.budget.maxOutputChars)
      throw new AgentRuntimeError('AGENT_LIMIT')
  }
}
