import { vocabularyInsertTools } from '../../learning/vocabulary/vocabulary-insert'
import {
  vocabularyModelArgsSchema,
  vocabularyPreparedSchema,
  vocabularyAnalysisReceiptSchema,
  type AgentCallArgs,
  type AgentOperation,
  type AgentSnapshot,
  type VocabularyPrepared
} from '../agent-protocol'
import { AgentRuntimeError, type VocabularyHostOperations } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'

export class VocabularyTask implements AgentTaskAdapter {
  readonly task = 'vocabulary'
  private prepareStarted = false
  private prepared?: VocabularyPrepared
  private readonly indices = new Set<number>()
  constructor(
    private readonly snapshot: AgentSnapshot,
    private readonly host: VocabularyHostOperations
  ) {}
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    if (operation === 'vocabulary.prepare') {
      if (Object.keys(args).length || this.prepareStarted)
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      this.prepareStarted = true
      return {
        kind: 'tool',
        output: 'none',
        execute: async (signal) => {
          const result = vocabularyPreparedSchema.parse(await this.host.prepare())
          signal.throwIfAborted()
          this.prepared = structuredClone(result)
          return result
        }
      }
    }
    if (operation !== 'model.vocabulary') throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    const parsed = vocabularyModelArgsSchema.parse(args)
    const item = this.prepared?.items.find(
      (item) => item.inputIndex === parsed.inputIndex && item.status === 'pending'
    )
    if (!item || this.indices.has(item.inputIndex))
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.indices.add(item.inputIndex)
    const content = JSON.stringify({ term: item.term, wordLanguage: this.snapshot.targetLanguage })
    if (
      parsed.systemPrompt.length + content.length + JSON.stringify(vocabularyInsertTools()).length >
      this.snapshot.budget.maxInputChars
    )
      throw new AgentRuntimeError('AGENT_LIMIT')
    return {
      kind: 'model',
      output: 'json',
      execute: async (signal) => {
        const result = vocabularyAnalysisReceiptSchema.parse(
          await this.host.analyze(parsed, signal)
        )
        signal.throwIfAborted()
        if (result.inputIndex !== item.inputIndex)
          throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        return result
      }
    }
  }
  verifyCompletion(frame: AgentSuccessFrame): void {
    if (frame.type !== 'vocabulary_result') throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.host.verifyCompletion(frame.result)
  }
}
