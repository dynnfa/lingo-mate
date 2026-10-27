import type { LanguageModel } from '../../llm/language-model'
import {
  agentReplyArgsSchema,
  agentHostResultSchema,
  type AgentCallArgs,
  type AgentOperation,
  type AgentSnapshot
} from '../agent-protocol'
import { AgentRuntimeError } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter, ResolveAgentModel } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'

export class ConversationTask implements AgentTaskAdapter {
  private model?: LanguageModel
  constructor(
    readonly task: 'conversation' | 'conversation-title',
    private readonly snapshot: AgentSnapshot,
    private readonly resolveModel: ResolveAgentModel
  ) {}
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    const isTitle = this.task === 'conversation-title'
    if (operation !== (isTitle ? 'model.title' : 'model.reply'))
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    const reply = agentReplyArgsSchema.parse(args)
    if (
      reply.systemPrompt.length + this.snapshot.messages.reduce((n, m) => n + m.content.length, 0) >
      this.snapshot.budget.maxInputChars
    )
      throw new AgentRuntimeError('AGENT_LIMIT')
    return {
      kind: 'model',
      output: 'none',
      execute: async (signal, emit) => {
        this.model ??= this.resolveModel()
        let text = ''
        for await (const event of this.model.streamReply({
          messages: this.snapshot.messages.map((m) => ({ ...m })),
          systemPrompt: reply.systemPrompt,
          purpose: isTitle ? 'conversation-title' : 'conversation',
          signal
        })) {
          signal.throwIfAborted()
          if (isTitle && event.type !== 'text') continue
          if (event.type === 'text') text += event.delta
          await emit(event)
        }
        return agentHostResultSchema.parse({ text })
      }
    }
  }
  verifyCompletion(frame: AgentSuccessFrame, streamedText: string): void {
    if (frame.type !== 'result' || frame.text !== streamedText)
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
  }
}
