import { AgentHost } from '../../agent-host'
import { createAgentTaskBinding, type AgentTaskBindingInput } from '../../agent-task-binding'
import { createAgentSnapshot } from '../../agent-runtime'
import type { AgentSnapshot } from '../../agent-protocol'

export function boundHost(
  input: Exclude<AgentTaskBindingInput, { task: 'conversation-route' }>,
  adjust?: (snapshot: AgentSnapshot) => void
): { host: AgentHost; binding: ReturnType<typeof createAgentTaskBinding> } {
  const snapshot = createAgentSnapshot({
    task: input.task,
    messages: [{ role: 'user', content: 'hello' }],
    outputLanguage: 'zh-CN',
    targetLanguage: 'en'
  })
  adjust?.(snapshot)
  const binding = createAgentTaskBinding(snapshot, input)
  return { host: new AgentHost(snapshot, binding), binding }
}
export const signal = (): AbortSignal => new AbortController().signal
export const noop = (): void => {}
