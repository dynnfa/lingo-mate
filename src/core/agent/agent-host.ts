import type { LanguageModel, ModelStreamEvent } from '../llm/language-model'
import {
  agentCallArgsSchema,
  agentHostResultSchema,
  agentDecisionSchema,
  agentReplyArgsSchema,
  type AgentDecision,
  type AgentCallArgs,
  type AgentHostResult,
  type AgentOperation,
  type AgentSnapshot
} from './agent-protocol'
import { AgentRuntimeError } from './agent-runtime'

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

export class AgentHost {
  private readonly calls = new Set<string>()
  private model?: LanguageModel
  private modelCalls = 0
  private outputChars = 0
  private toolCalls = 0
  private results: Array<{ entries: string[] }> = []
  private query?: string
  constructor(
    private readonly snapshot: AgentSnapshot,
    private readonly resolveModel: () => LanguageModel,
    private readonly testOperations?: AgentTestOperations
  ) {
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
    if (!this.snapshot.allowedOperations.includes(operation) || this.calls.has(callId))
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.calls.add(callId)
    const parsedArgs = agentCallArgsSchema.safeParse(rawArgs)
    if (!parsedArgs.success)
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR', { cause: parsedArgs.error })
    const args = parsedArgs.data
    if (this.calls.size > this.snapshot.budget.maxSteps) throw new AgentRuntimeError('AGENT_LIMIT')
    if (operation === 'model.decide' && this.testOperations) {
      if (
        args.systemPrompt !== undefined ||
        args.query ||
        JSON.stringify(args.results) !== JSON.stringify(this.results)
      )
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      if (++this.modelCalls > this.snapshot.budget.maxModelCalls)
        throw new AgentRuntimeError('AGENT_LIMIT')
      const decision = agentDecisionSchema.parse(
        await this.testOperations.decide({
          messages: structuredClone(this.snapshot.messages),
          outputLanguage: this.snapshot.outputLanguage,
          targetLanguage: this.snapshot.targetLanguage,
          results: structuredClone(this.results),
          signal
        })
      )
      signal.throwIfAborted()
      if (decision.kind === 'tool') this.query = decision.query
      else {
        this.outputChars += decision.text.length
        if (this.outputChars > this.snapshot.budget.maxOutputChars)
          throw new AgentRuntimeError('AGENT_LIMIT')
      }
      return decision
    }
    if (operation === 'learning.lookup' && this.testOperations) {
      if (
        args.systemPrompt !== undefined ||
        !args.query ||
        args.query !== this.query ||
        args.results
      )
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      this.query = undefined
      if (++this.toolCalls > this.snapshot.budget.maxToolCalls)
        throw new AgentRuntimeError('AGENT_LIMIT')
      signal.throwIfAborted()
      const result = agentHostResultSchema.parse(
        await this.testOperations.lookup(args.query, signal)
      )
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
    if (operation !== 'model.reply') throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    const reply = agentReplyArgsSchema.safeParse(args)
    if (!reply.success) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR', { cause: reply.error })
    if (
      reply.data.systemPrompt.length +
        this.snapshot.messages.reduce((n, m) => n + m.content.length, 0) >
      this.snapshot.budget.maxInputChars
    )
      throw new AgentRuntimeError('AGENT_LIMIT')
    if (++this.modelCalls > this.snapshot.budget.maxModelCalls)
      throw new AgentRuntimeError('AGENT_LIMIT')
    this.model ??= this.resolveModel()
    let text = ''
    for await (const event of this.model.streamReply({
      messages: this.snapshot.messages.map((m) => ({ ...m })),
      systemPrompt: reply.data.systemPrompt,
      purpose: 'conversation',
      signal
    })) {
      signal.throwIfAborted()
      this.outputChars += event.delta.length
      if (this.outputChars > this.snapshot.budget.maxOutputChars)
        throw new AgentRuntimeError('AGENT_LIMIT')
      if (event.type === 'text') text += event.delta
      await emit(event)
    }
    signal.throwIfAborted()
    return agentHostResultSchema.parse({ text })
  }
}
