import {
  CONVERSATION_TEXT_MAX_CHARS,
  splitConversationCommand
} from '../../../shared/conversation-command'
import { conversationSkillIdSchema } from '../../../shared/conversation'
import { ModelRequestError } from '../../llm/llm-client'
import {
  agentReplyArgsSchema,
  conversationIntentSchema,
  type AgentCallArgs,
  type AgentOperation,
  type AgentSnapshot,
  type ConversationIntent,
  type ConversationRouteInput,
  type ConversationRouteResult
} from '../agent-protocol'
import { AgentRuntimeError } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter, ResolveAgentModel } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'

export function describeConversationRoute(
  mode: ConversationRouteInput['mode'],
  text: string
): ConversationRouteInput {
  const command = splitConversationCommand(text)
  return {
    mode,
    command: command ? (command.command.length <= 64 ? command.command : '') : null,
    hasArguments: Boolean(command?.body.trim())
  }
}

interface Binding {
  text: string
  resolveModel: ResolveAgentModel
  complete(result: ConversationRouteResult): void
  modelStarted(): void
}

export class ConversationRouteTask implements AgentTaskAdapter {
  readonly task = 'conversation-route'
  private intent?: ConversationIntent
  private readonly classify: boolean

  constructor(
    private readonly snapshot: Extract<AgentSnapshot, { task: 'conversation-route' }>,
    private readonly binding: Binding
  ) {
    const { mode, command, hasArguments } = describeConversationRoute(
      snapshot.route.mode,
      binding.text
    )
    if (
      snapshot.inputChars !== binding.text.length ||
      snapshot.route.command !== command ||
      snapshot.route.hasArguments !== hasArguments
    )
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.classify = mode === 'desktop' && command === null
  }

  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    if (operation !== 'model.classify-conversation' || !this.classify)
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    const { systemPrompt } = agentReplyArgsSchema.parse(args)
    if (
      this.binding.text.length > CONVERSATION_TEXT_MAX_CHARS ||
      systemPrompt.length + this.binding.text.length > this.snapshot.budget.maxInputChars
    )
      throw new AgentRuntimeError('AGENT_LIMIT')

    return {
      kind: 'model',
      output: 'json',
      execute: async (signal) => {
        const model = this.binding.resolveModel()
        this.binding.modelStarted()
        let text = ''
        for await (const event of model.streamReply({
          purpose: 'conversation-route',
          messages: [{ role: 'user', content: this.binding.text }],
          systemPrompt,
          timeoutMs: 10_000,
          signal
        })) {
          signal.throwIfAborted()
          if (event.type !== 'text') continue
          text += event.delta
          if (text.length > this.snapshot.budget.maxOutputChars)
            throw new ModelRequestError('PROTOCOL', new Error('Intent classification is too long'))
        }
        const result = conversationIntentSchema.safeParse(text.trim())
        if (!result.success)
          throw new ModelRequestError('PROTOCOL', new Error('Invalid intent classification'))
        this.intent = result.data
        return { intent: result.data }
      }
    }
  }

  verifyCompletion(frame: AgentSuccessFrame): void {
    if (frame.type !== 'conversation_route_result')
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    const { result } = frame
    const { command, mode, hasArguments } = this.snapshot.route

    // Validate the selected identity and disposition against the trusted request.
    // A read-only model receipt cannot authorize an explicit or writing workflow.
    let valid: boolean
    if (this.classify) {
      valid =
        this.intent === 'concept'
          ? result.kind === 'workflow' && result.workflow === 'concept'
          : this.intent !== undefined && result.kind === 'reply'
    } else if (command === 'concept' && (mode === 'desktop' || mode === 'retry')) {
      valid = result.kind === 'workflow' && result.workflow === command
    } else if (
      (mode === 'desktop' && conversationSkillIdSchema.safeParse(command).success) ||
      (mode === 'channel-sentence' && command === 'sentence')
    ) {
      const requiresArguments = command !== 'explore-phrase' && command !== 'explore-vocabulary'
      const kind = hasArguments === requiresArguments ? 'workflow' : 'invalid'
      valid = result.kind === kind && result.workflow === command
    } else {
      valid = result.kind === 'reply'
    }
    if (!valid) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.binding.complete(result)
  }
}
