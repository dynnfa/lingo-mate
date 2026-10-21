import type { ModelMessage, ModelStreamEvent } from '../llm/language-model'
import {
  agentSnapshotSchema,
  type AgentBudget,
  type AgentErrorCode,
  type AgentSnapshot
} from './agent-protocol'

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  timeoutMs: 120_000,
  maxModelCalls: 3,
  maxToolCalls: 2,
  maxSteps: 16,
  maxInputChars: 32_768,
  maxOutputChars: 32_768
}
export interface AgentTask {
  task: AgentSnapshot['task']
  messages: ModelMessage[]
  outputLanguage: string
  targetLanguage: string
}
export interface AgentRunInput extends AgentTask {
  sessionId: string
  signal: AbortSignal
}
export interface AgentRuntime {
  stream(input: AgentRunInput): AsyncIterable<ModelStreamEvent>
}
export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options)
    this.name = 'AgentRuntimeError'
  }
}

// Reserve space for the fixed host prompt/operation definitions. Persisted history
// is never edited; only this execution's copied context is trimmed.
export function createAgentSnapshot(input: AgentTask): AgentSnapshot {
  let remaining = DEFAULT_AGENT_BUDGET.maxInputChars - 4096
  const messages: ModelMessage[] = []
  for (const message of input.messages.slice(-100).reverse()) {
    if (remaining <= 0) break
    let start = Math.max(0, message.content.length - remaining)
    const first = message.content.charCodeAt(start)
    const previous = message.content.charCodeAt(start - 1)
    if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start++
    const content = message.content.slice(start)
    messages.unshift({ role: message.role, content })
    remaining -= content.length
  }
  return agentSnapshotSchema.parse({
    ...input,
    messages,
    budget: { ...DEFAULT_AGENT_BUDGET },
    allowedOperations:
      input.task === 'tool-loop' ? ['model.decide', 'learning.lookup'] : ['model.reply']
  })
}
