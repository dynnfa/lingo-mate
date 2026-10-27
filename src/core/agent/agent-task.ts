import type { LanguageModel, ModelStreamEvent } from '../llm/language-model'
import type {
  AgentCallArgs,
  AgentDecision,
  AgentHostResult,
  AgentOperation,
  AgentSnapshot
} from './agent-protocol'
import type { AgentSuccessFrame, AgentTaskPolicy } from './agent-task-policy'

export interface AgentTestOperations {
  // Installed only by controlled tests. Production registers no tool handlers.
  decide(
    input: Pick<AgentSnapshot, 'messages' | 'outputLanguage' | 'targetLanguage'> & {
      results: Array<{ entries: string[] }>
      signal: AbortSignal
    }
  ): Promise<AgentDecision>
  lookup(query: string, signal: AbortSignal): Promise<{ entries: string[] }>
}
export type ResolveAgentModel = () => LanguageModel
export type EmitAgentEvent = (event: ModelStreamEvent) => void | Promise<void>

export interface AgentCallPlan {
  readonly kind: 'model' | 'tool'
  // Preserve the original per-task accounting. Streaming deltas are charged by
  // AgentHost's emit wrapper; the final text must not be charged a second time.
  readonly output: 'json' | 'decision' | 'none'
  execute(signal: AbortSignal, emit: EmitAgentEvent): Promise<AgentHostResult>
}
export interface AgentTaskAdapter {
  readonly task: AgentSnapshot['task']
  // Validate and claim local state only; no model, tool or storage effects here.
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan
  verifyCompletion(frame: AgentSuccessFrame, streamedText: string): void
}
export interface AgentTaskBinding {
  readonly task: AgentSnapshot['task']
  readonly policy: AgentTaskPolicy
  readonly adapter: AgentTaskAdapter
}
