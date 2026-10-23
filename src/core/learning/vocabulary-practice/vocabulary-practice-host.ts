import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { z } from 'zod'
import { VOCABULARY_PRACTICE_SUMMARY_MAX_LENGTH } from '../../../shared/vocabulary-practice'
import {
  vocabularyPracticeModelArgsSchema,
  vocabularyPracticeApplyArgsSchema,
  vocabularyPracticeCorrectArgsSchema,
  vocabularyPracticeFinishArgsSchema,
  type VocabularyPracticeModelArgs,
  type VocabularyPracticeApplyArgs,
  type VocabularyPracticeCorrectArgs,
  type VocabularyPracticeFinishArgs,
  type VocabularyPracticeTurn,
  type VocabularyPracticeCompletion
} from '../../agent/agent-protocol'
import { AgentRuntimeError, type VocabularyPracticeHostOperations } from '../../agent/agent-runtime'
import {
  VocabularyPracticeToolExecutor,
  vocabularyPracticeTools
} from '../../tools/vocabulary-practice-tools'
import { VocabularyPracticeError } from './parse-vocabulary-practice-input'
import type {
  VocabularyPracticeModel,
  VocabularyPracticeModelMessage,
  PracticeReviewEntry,
  PracticeReviewOutcome
} from './vocabulary-practice-reviewer'

const feedbackSchema = z.strictObject({
  verdict: z.enum(['all_correct', 'has_errors']),
  summary: z.string().trim().min(1).max(VOCABULARY_PRACTICE_SUMMARY_MAX_LENGTH)
})

// Per-run ledger. No result reaches the service (or its mistake sink) before graph verification.
export class VocabularyPracticeHost implements VocabularyPracticeHostOperations {
  private prepared = false
  private closed = false
  private busy = false
  private verified = false
  private finished = false
  private round = 0
  private corrections = 0
  private prompt?: string
  private pending?: VocabularyPracticeModelMessage
  private kind?: VocabularyPracticeTurn['kind']
  private staged?: PracticeReviewOutcome
  private readonly messages: ChatCompletionMessageParam[]
  private readonly executor: VocabularyPracticeToolExecutor
  private readonly ids = new Set<string>()

  constructor(
    entries: PracticeReviewEntry[],
    private readonly modelClient: VocabularyPracticeModel,
    private readonly signal: AbortSignal
  ) {
    const bound = structuredClone(entries)
    this.messages = [{ role: 'user', content: JSON.stringify({ entries: bound }) }]
    this.executor = new VocabularyPracticeToolExecutor(
      new Set(bound.map((entry) => entry.entryId)),
      signal
    )
  }

  prepare(): { inputChars: number } {
    this.check(!this.prepared && !this.finished)
    this.prepared = true
    const inputChars =
      JSON.stringify(this.messages).length + JSON.stringify(vocabularyPracticeTools()).length
    if (inputChars > 65_536) throw new AgentRuntimeError('AGENT_LIMIT')
    return { inputChars }
  }

  async model(
    raw: VocabularyPracticeModelArgs,
    signal: AbortSignal,
    maxInputChars: number
  ): Promise<VocabularyPracticeTurn> {
    const args = vocabularyPracticeModelArgsSchema.parse(raw)
    this.check(
      this.prepared &&
        !this.finished &&
        !this.busy &&
        !this.pending &&
        !this.staged &&
        args.round === this.round + 1
    )
    signal.throwIfAborted()
    if (!this.prompt) {
      this.prompt = args.systemPrompt
      this.messages.unshift({ role: 'system', content: args.systemPrompt })
    }
    this.check(this.prompt === args.systemPrompt)
    const inputChars =
      JSON.stringify(this.messages).length + JSON.stringify(vocabularyPracticeTools()).length
    if (inputChars > maxInputChars) throw new AgentRuntimeError('AGENT_LIMIT')
    this.round = args.round
    this.busy = true
    try {
      const message = await this.modelClient.complete({
        messages: structuredClone(this.messages),
        signal
      })
      signal.throwIfAborted()
      this.check(true)
      if (JSON.stringify(message).length > 65_536 || message.refusal)
        throw new VocabularyPracticeError('INVALID_ANALYSIS')
      const calls = message.tool_calls ?? []
      if (calls.length) {
        for (const call of calls) {
          if (!call.id || this.ids.has(call.id))
            throw new VocabularyPracticeError('INVALID_ANALYSIS')
          this.ids.add(call.id)
        }
        this.kind = 'tools'
      } else {
        let value: unknown
        try {
          value = JSON.parse(message.content ?? '')
        } catch (cause) {
          throw new VocabularyPracticeError('INVALID_ANALYSIS', { cause })
        }
        const parsed = feedbackSchema.safeParse(value)
        if (!parsed.success)
          throw new VocabularyPracticeError('INVALID_ANALYSIS', { cause: parsed.error })
        const marks = this.executor.marked
        if (parsed.data.verdict === 'all_correct' && marks.length)
          throw new VocabularyPracticeError('INVALID_ANALYSIS')
        if (parsed.data.verdict === 'has_errors' && !marks.length) this.kind = 'missing_marks'
        else {
          this.staged = { ...parsed.data, marks }
          this.kind = 'complete'
        }
      }
      this.pending = message
      return { round: this.round, kind: this.kind, inputChars }
    } finally {
      this.busy = false
    }
  }

  apply(raw: VocabularyPracticeApplyArgs, signal: AbortSignal): { round: number; applied: true } {
    const args = vocabularyPracticeApplyArgsSchema.parse(raw)
    this.checkPending(args.round, 'tools')
    signal.throwIfAborted()
    const message = this.pending!
    this.messages.push({ ...message, role: 'assistant' })
    for (const call of message.tool_calls!) {
      let result: unknown
      try {
        const outcome = this.executor.execute(
          call.function.name,
          JSON.parse(call.function.arguments)
        )
        result = outcome.ok ? outcome.result : { error: outcome.error }
      } catch (cause) {
        if (!(cause instanceof SyntaxError)) throw cause
        result = { error: 'INVALID_ARGUMENTS' }
      }
      this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
    this.pending = undefined
    return { round: this.round, applied: true }
  }

  correct(
    raw: VocabularyPracticeCorrectArgs,
    signal: AbortSignal
  ): { round: number; applied: true } {
    const args = vocabularyPracticeCorrectArgsSchema.parse(raw)
    this.checkPending(args.round, 'missing_marks')
    signal.throwIfAborted()
    this.check(this.corrections < 2)
    this.corrections++
    this.messages.push({ role: 'user', content: args.instruction })
    this.pending = undefined
    return { round: this.round, applied: true }
  }

  finish(raw: VocabularyPracticeFinishArgs): VocabularyPracticeCompletion {
    const args = vocabularyPracticeFinishArgsSchema.parse(raw)
    this.check(this.prepared && !this.finished && !this.busy && args.round === this.round)
    if (args.reason === 'correction_limit') {
      this.checkPending(args.round, 'missing_marks')
      this.check(this.corrections === 2)
      throw new VocabularyPracticeError('INVALID_ANALYSIS')
    }
    if (args.reason === 'round_limit') {
      this.check(this.round === 8 && !this.pending && !this.staged)
      throw new VocabularyPracticeError('ROUND_LIMIT')
    }
    this.checkPending(args.round, 'complete')
    this.check(!!this.staged)
    this.finished = true
    return { completed: true, rounds: this.round }
  }

  verifyCompletion(result: VocabularyPracticeCompletion): void {
    this.check(
      this.finished &&
        !this.verified &&
        result.completed &&
        result.rounds === this.round &&
        !!this.staged
    )
    this.verified = true
  }

  result(): PracticeReviewOutcome {
    this.check(this.verified && !!this.staged)
    return structuredClone(this.staged!)
  }
  close(): void {
    this.closed = true
  }
  private checkPending(round: number, kind: VocabularyPracticeTurn['kind']): void {
    this.check(
      !this.finished && !this.busy && !!this.pending && round === this.round && this.kind === kind
    )
  }
  private check(valid: boolean): void {
    this.signal.throwIfAborted()
    if (this.closed || !valid) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
  }
}
