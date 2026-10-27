import {
  vocabularyPracticePreparedSchema,
  vocabularyPracticeTurnSchema,
  vocabularyPracticeAppliedSchema,
  vocabularyPracticeCompletionSchema,
  vocabularyPracticeModelArgsSchema,
  vocabularyPracticeApplyArgsSchema,
  vocabularyPracticeCorrectArgsSchema,
  vocabularyPracticeFinishArgsSchema,
  type AgentCallArgs,
  type AgentOperation,
  type AgentSnapshot
} from '../agent-protocol'
import { AgentRuntimeError, type VocabularyPracticeHostOperations } from '../agent-runtime'
import type { AgentCallPlan, AgentTaskAdapter } from '../agent-task'
import type { AgentSuccessFrame } from '../agent-task-policy'

export class VocabularyPracticeTask implements AgentTaskAdapter {
  readonly task = 'vocabulary-practice-review'
  constructor(
    private readonly snapshot: AgentSnapshot,
    private readonly host: VocabularyPracticeHostOperations
  ) {}
  prepareCall(operation: AgentOperation, args: AgentCallArgs): AgentCallPlan {
    switch (operation) {
      case 'vocabulary-practice.prepare':
        if (Object.keys(args).length) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        return {
          kind: 'tool',
          output: 'json',
          execute: async () => vocabularyPracticePreparedSchema.parse(this.host.prepare())
        }
      case 'model.vocabulary-practice-review': {
        const parsed = vocabularyPracticeModelArgsSchema.parse(args)
        return {
          kind: 'model',
          output: 'json',
          execute: async (signal) =>
            vocabularyPracticeTurnSchema.parse(
              await this.host.model(parsed, signal, this.snapshot.budget.maxInputChars)
            )
        }
      }
      case 'vocabulary-practice.apply': {
        const parsed = vocabularyPracticeApplyArgsSchema.parse(args)
        return {
          kind: 'tool',
          output: 'json',
          execute: async (signal) =>
            vocabularyPracticeAppliedSchema.parse(this.host.apply(parsed, signal))
        }
      }
      case 'vocabulary-practice.correct': {
        const parsed = vocabularyPracticeCorrectArgsSchema.parse(args)
        return {
          kind: 'tool',
          output: 'json',
          execute: async (signal) =>
            vocabularyPracticeAppliedSchema.parse(this.host.correct(parsed, signal))
        }
      }
      case 'vocabulary-practice.finish': {
        const parsed = vocabularyPracticeFinishArgsSchema.parse(args)
        return {
          kind: 'tool',
          output: 'json',
          execute: async () => vocabularyPracticeCompletionSchema.parse(this.host.finish(parsed))
        }
      }
      default:
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    }
  }
  verifyCompletion(frame: AgentSuccessFrame): void {
    if (frame.type !== 'vocabulary_practice_result')
      throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    this.host.verifyCompletion(frame.result)
  }
}
