import { phraseInsertTools } from '../../learning/phrase/phrase-tools'
import {
  phraseModelArgsSchema,
  phrasePreparedSchema,
  phraseAnalysisReceiptSchema,
  type AgentCallArgs,
  type AgentOperation,
  type AgentSnapshot,
  type PhrasePrepared
} from '../agent-protocol'
import { AgentRuntimeError, type PhraseHostOperations } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'

export class PhraseTask implements AgentTaskAdapter {
  readonly task = 'phrase'
  private prepareStarted = false
  private prepared?: PhrasePrepared
  private readonly indices = new Set<number>()
  constructor(
    private readonly snapshot: AgentSnapshot,
    private readonly host: PhraseHostOperations
  ) {}
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    if (operation === 'phrase.prepare') {
      if (Object.keys(args).length || this.prepareStarted)
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      this.prepareStarted = true
      return {
        kind: 'tool',
        output: 'none',
        execute: async (signal) => {
          const result = phrasePreparedSchema.parse(await this.host.prepare())
          signal.throwIfAborted()
          this.prepared = structuredClone(result)
          return result
        }
      }
    }
    if (operation !== 'model.phrase') throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    const parsed = phraseModelArgsSchema.parse(args)
    const item = this.prepared?.items.find(
      (item) => item.inputIndex === parsed.inputIndex && item.status === 'pending'
    )
    if (!item || this.indices.has(item.inputIndex))
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.indices.add(item.inputIndex)
    const content = JSON.stringify({
      phrase: item.phrase,
      wordLanguage: this.snapshot.targetLanguage
    })
    if (
      parsed.systemPrompt.length + content.length + JSON.stringify(phraseInsertTools()).length >
      this.snapshot.budget.maxInputChars
    )
      throw new AgentRuntimeError('AGENT_LIMIT')
    return {
      kind: 'model',
      output: 'json',
      execute: async (signal) => {
        const result = phraseAnalysisReceiptSchema.parse(await this.host.analyze(parsed, signal))
        signal.throwIfAborted()
        if (result.inputIndex !== item.inputIndex)
          throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        return result
      }
    }
  }
  verifyCompletion(frame: AgentSuccessFrame): void {
    if (frame.type !== 'phrase_result') throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.host.verifyCompletion(frame.result)
  }
}
