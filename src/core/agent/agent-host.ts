import { phraseInsertTools } from '../tools/phrase-tools'
import { vocabularyInsertTools } from '../learning/vocabulary/vocabulary-insert'
import type { LanguageModel, ModelStreamEvent } from '../llm/language-model'
import {
  agentCallArgsSchema,
  agentHostResultSchema,
  agentDecisionSchema,
  agentReplyArgsSchema,
  vocabularyModelArgsSchema,
  vocabularyPreparedSchema,
  vocabularyAnalysisReceiptSchema,
  phraseModelArgsSchema,
  phrasePreparedSchema,
  phraseAnalysisReceiptSchema,
  type AgentDecision,
  type AgentCallArgs,
  type AgentHostResult,
  type AgentOperation,
  type VocabularyPrepared,
  type PhrasePrepared,
  type AgentSnapshot
} from './agent-protocol'
import {
  AgentRuntimeError,
  type VocabularyHostOperations,
  type PhraseHostOperations
} from './agent-runtime'

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
  private phrasePrepared?: PhrasePrepared
  private readonly phraseIndices = new Set<number>()
  private prepared?: VocabularyPrepared
  private readonly vocabularyIndices = new Set<number>()
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
    private readonly testOperations?: AgentTestOperations,
    private readonly vocabulary?: VocabularyHostOperations,
    private readonly phrase?: PhraseHostOperations
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
    if (operation === 'vocabulary.prepare' && this.vocabulary) {
      if (Object.keys(args).length || ++this.toolCalls > 1)
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      if (this.toolCalls > this.snapshot.budget.maxToolCalls)
        throw new AgentRuntimeError('AGENT_LIMIT')
      const result = vocabularyPreparedSchema.parse(await this.vocabulary.prepare())
      signal.throwIfAborted()
      this.prepared = structuredClone(result)
      return result
    }
    if (operation === 'model.vocabulary' && this.vocabulary) {
      const parsed = vocabularyModelArgsSchema.safeParse(args)
      if (!parsed.success)
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR', { cause: parsed.error })
      const item = this.prepared?.items.find(
        (item) => item.inputIndex === parsed.data.inputIndex && item.status === 'pending'
      )
      if (!item || this.vocabularyIndices.has(item.inputIndex))
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      this.vocabularyIndices.add(item.inputIndex)
      if (++this.modelCalls > this.snapshot.budget.maxModelCalls)
        throw new AgentRuntimeError('AGENT_LIMIT')
      const content = JSON.stringify({
        term: item.term,
        wordLanguage: this.snapshot.targetLanguage
      })
      if (
        parsed.data.systemPrompt.length +
          content.length +
          JSON.stringify(vocabularyInsertTools()).length >
        this.snapshot.budget.maxInputChars
      )
        throw new AgentRuntimeError('AGENT_LIMIT')
      const result = vocabularyAnalysisReceiptSchema.parse(
        await this.vocabulary.analyze(parsed.data, signal)
      )
      signal.throwIfAborted()
      if (result.inputIndex !== item.inputIndex) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      this.outputChars += JSON.stringify(result).length
      if (this.outputChars > this.snapshot.budget.maxOutputChars)
        throw new AgentRuntimeError('AGENT_LIMIT')
      return result
    }
    if (operation === 'phrase.prepare' && this.phrase) {
      if (Object.keys(args).length || ++this.toolCalls > 1)
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      if (this.toolCalls > this.snapshot.budget.maxToolCalls)
        throw new AgentRuntimeError('AGENT_LIMIT')
      const result = phrasePreparedSchema.parse(await this.phrase.prepare())
      signal.throwIfAborted()
      this.phrasePrepared = structuredClone(result)
      return result
    }
    if (operation === 'model.phrase' && this.phrase) {
      const parsed = phraseModelArgsSchema.safeParse(args)
      if (!parsed.success)
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR', { cause: parsed.error })
      const item = this.phrasePrepared?.items.find(
        (item) => item.inputIndex === parsed.data.inputIndex && item.status === 'pending'
      )
      if (!item || this.phraseIndices.has(item.inputIndex))
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      this.phraseIndices.add(item.inputIndex)
      if (++this.modelCalls > this.snapshot.budget.maxModelCalls)
        throw new AgentRuntimeError('AGENT_LIMIT')
      const content = JSON.stringify({
        phrase: item.phrase,
        wordLanguage: this.snapshot.targetLanguage
      })
      if (
        parsed.data.systemPrompt.length +
          content.length +
          JSON.stringify(phraseInsertTools()).length >
        this.snapshot.budget.maxInputChars
      )
        throw new AgentRuntimeError('AGENT_LIMIT')
      const result = phraseAnalysisReceiptSchema.parse(
        await this.phrase.analyze(parsed.data, signal)
      )
      signal.throwIfAborted()
      if (result.inputIndex !== item.inputIndex) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      this.outputChars += JSON.stringify(result).length
      if (this.outputChars > this.snapshot.budget.maxOutputChars)
        throw new AgentRuntimeError('AGENT_LIMIT')
      return result
    }
    if (operation === 'model.decide' && this.testOperations) {
      if (
        args.inputIndex !== undefined ||
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
        args.inputIndex !== undefined ||
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
