import { ttsCompletionSchema, type AgentCallArgs, type AgentOperation } from '../agent-protocol'
import { AgentRuntimeError, type TtsHostOperations } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'

export class TtsTask implements AgentTaskAdapter {
  readonly task = 'tts'
  constructor(private readonly host: TtsHostOperations) {}
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    if (operation !== 'tts.synthesize' || Object.keys(args).length)
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    return {
      kind: 'tool',
      output: 'none',
      execute: async (signal) => ttsCompletionSchema.parse(await this.host.synthesize(signal))
    }
  }
  verifyCompletion(frame: AgentSuccessFrame): void {
    if (frame.type !== 'tts_result') throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.host.verifyCompletion(frame.result)
  }
}
