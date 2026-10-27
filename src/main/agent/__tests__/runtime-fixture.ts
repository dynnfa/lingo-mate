import { vi } from 'vitest'
import { AGENT_PROTOCOL_VERSION, type AgentFrame } from '../../../core/agent/agent-protocol'
import { AgentRuntimeError } from '../../../core/agent/agent-runtime'
import { PythonAgentProcess, type AgentPayload } from '../python-agent-process'

export class ControlledProcess extends PythonAgentProcess {
  readonly sent: AgentPayload[] = []
  private receiver: (frame: AgentFrame) => void = () => {}
  private failure: (error: AgentRuntimeError) => void = () => {}
  onSend?: (payload: AgentPayload) => void | Promise<void>
  constructor() {
    super({ command: '', args: [] })
    this.status = 'ready'
    this.instanceId = 'controlled'
  }
  override subscribe(
    receiver: (frame: AgentFrame) => void,
    failure: (error: AgentRuntimeError) => void
  ): () => void {
    this.receiver = receiver
    this.failure = failure
    return () => {}
  }
  override start = vi.fn(async () => {})
  override async send(payload: AgentPayload): Promise<void> {
    this.sent.push(payload)
    await this.onSend?.(payload)
  }
  emit(payload: AgentPayload): void {
    this.receiver({
      ...payload,
      v: AGENT_PROTOCOL_VERSION,
      instanceId: this.instanceId
    } as AgentFrame)
  }
  override invalidate = vi.fn(
    (code: 'AGENT_UNAVAILABLE' | 'AGENT_PROTOCOL_ERROR' = 'AGENT_PROTOCOL_ERROR') => {
      this.failure(new AgentRuntimeError(code))
    }
  )
  override async shutdown(): Promise<void> {
    this.status = 'closed'
  }
}

export const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

export function sentRun(child: ControlledProcess): Extract<AgentPayload, { type: 'run' }> {
  const run = child.sent.find((frame) => frame.type === 'run')
  if (!run || run.type !== 'run') throw new Error('Run has not been sent')
  return run
}
