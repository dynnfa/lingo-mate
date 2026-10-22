import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import {
  synonymBatchSchema,
  synonymOutcome,
  type SynonymBatch,
  type SynonymItemResult
} from '../../../shared/synonym'
import type { ConversationSkillRunInput } from '../../conversation/conversation-skill'
import { AgentRuntimeError, type SynonymHostOperations } from '../../agent/agent-runtime'
import {
  synonymModelArgsSchema,
  synonymApplyArgsSchema,
  synonymFinishArgsSchema,
  type SynonymPrepared,
  type SynonymTurn,
  type SynonymApplied,
  type SynonymFinished,
  type SynonymCompletion,
  type SynonymModelArgs,
  type SynonymApplyArgs,
  type SynonymFinishArgs
} from '../../agent/agent-protocol'
import { synonymTools, SynonymToolExecutor } from '../../tools/synonym-tools'
import type { SynonymRepository } from './synonym-repository'
import type { SynonymAnalyzer, SynonymModelTurn } from './synonym-analyzer'
import { parseSynonymInput, SynonymError } from './parse-synonym-input'
import { abortableSynonymOperation } from './abortable-operation'
import { noopCoreDiagnostics, type CoreDiagnostics } from '../../error-diagnostics'
import { summarizeSynonymFailure } from './synonym-diagnostics'

// Trusted ledger: Python sees only indices, turn kinds, counters and safe receipts.
export class SynonymHost implements SynonymHostOperations {
  private readonly items: ReturnType<typeof parseSynonymInput>
  private readonly results: SynonymItemResult[]
  private pending: number[] = []
  private position = 0
  private round = 0
  private messages: ChatCompletionMessageParam[] = []
  private readonly ids = new Set<string>()
  private proposal?: SynonymModelTurn
  private executor?: SynonymToolExecutor
  private corrected = false
  private failure?: SynonymError
  private terminal = false
  private busy = false
  private prepared = false
  private closed = false
  private verified = false
  private deadline = 0
  private prompt?: string
  private analyzer?: SynonymAnalyzer
  private configurationError?: unknown
  private resolved = false
  private readonly completed = new Set<number>()

  constructor(
    private readonly repository: SynonymRepository,
    private readonly createAnalyzer: (timeoutMs: number) => SynonymAnalyzer,
    private readonly input: ConversationSkillRunInput,
    private readonly wordMs = 60_000,
    private readonly diagnostics: CoreDiagnostics = noopCoreDiagnostics
  ) {
    if (!('text' in input.arguments)) throw new SynonymError('INVALID_INPUT')
    this.items = parseSynonymInput(input.arguments.text)
    const previous = input.previousReport
      ? synonymBatchSchema.parse(input.previousReport)
      : undefined
    this.results = this.items.map((item) => {
      const prior = previous?.items[item.inputIndex]
      if (prior?.word === item.word && ['saved', 'existing', 'unrecognized'].includes(prior.status))
        return prior
      return item.sourceInputIndex === undefined
        ? { inputIndex: item.inputIndex, input: item.input, word: item.word, status: 'cancelled' }
        : { ...item, status: 'duplicate', sourceInputIndex: item.sourceInputIndex }
    })
  }

  prepare(): SynonymPrepared {
    this.check(!this.prepared)
    this.prepared = true
    this.persist(false)
    const existing = this.repository.findExisting(this.items.map((i) => i.word))
    for (const item of this.items) {
      if (this.results[item.inputIndex].status !== 'cancelled') continue
      const entry = existing.get(item.word)
      if (entry) this.results[item.inputIndex] = { ...item, status: 'existing', entry }
      else this.pending.push(item.inputIndex)
    }
    this.persist(false)
    return {
      items: this.items.map((item) => ({
        inputIndex: item.inputIndex,
        status: this.pending.includes(item.inputIndex) ? 'pending' : 'resolved'
      }))
    }
  }

  async model(
    raw: SynonymModelArgs,
    signal: AbortSignal,
    maxInputChars = 65_536
  ): Promise<SynonymTurn> {
    const args = synonymModelArgsSchema.parse(raw)
    this.checkCurrent(args.inputIndex)
    this.check(
      !this.busy &&
        !this.proposal &&
        !this.terminal &&
        !this.failure &&
        args.round === this.round + 1
    )
    signal.throwIfAborted()
    if (!this.round) {
      this.deadline = performance.now() + this.wordMs
      this.prompt = args.systemPrompt
      const word = this.items[args.inputIndex].word
      this.messages = [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: JSON.stringify({ word, wordLanguage: 'en' }) }
      ]
      this.executor = new SynonymToolExecutor(
        word,
        this.repository,
        (content) => {
          this.checkCurrent(args.inputIndex)
          signal.throwIfAborted()
          this.checkDeadline()
          const saved = this.repository.saveWord(this.input.executionId, content, (value) => {
            const updated = [...this.results]
            updated[args.inputIndex] = { ...this.items[args.inputIndex], ...value }
            return this.report(false, updated)
          })
          this.results[args.inputIndex] = { ...this.items[args.inputIndex], ...saved }
          return saved
        },
        signal
      )
    }
    this.check(args.systemPrompt === this.prompt)
    const inputChars = JSON.stringify(this.messages).length + JSON.stringify(synonymTools()).length
    if (inputChars > maxInputChars) throw new AgentRuntimeError('AGENT_LIMIT')
    this.round = args.round
    this.busy = true
    try {
      this.checkDeadline()
      if (!this.resolved) {
        this.resolved = true
        try {
          this.analyzer = this.createAnalyzer(this.wordMs)
        } catch (cause) {
          this.configurationError = cause
        }
      }
      if (!this.analyzer) throw this.configurationError
      const turn = await abortableSynonymOperation(
        signal,
        Math.max(1, this.deadline - performance.now()),
        (childSignal) =>
          this.analyzer!.analyze({ messages: structuredClone(this.messages), signal: childSignal })
      )
      signal.throwIfAborted()
      this.checkCurrent(args.inputIndex)
      this.checkDeadline()
      // Also validate substitutes; adapter schema validation is not an authorization boundary.
      if (turn.message.content || turn.message.refusal || !turn.message.tool_calls.length)
        throw new SynonymError('INVALID_ANALYSIS')
      for (const call of turn.message.tool_calls) {
        if (!call.id || this.ids.has(call.id)) throw new SynonymError('INVALID_ANALYSIS')
        this.ids.add(call.id)
      }
      if (turn.message.tool_calls.length > 1 && (!turn.canCorrectParallel || this.corrected))
        throw new SynonymError('INVALID_ANALYSIS')
      if (JSON.stringify(turn.message).length > 65_536) throw new SynonymError('INVALID_ANALYSIS')
      this.proposal = turn
      return {
        inputIndex: args.inputIndex,
        round: this.round,
        kind: turn.message.tool_calls.length === 1 ? 'tool' : 'parallel',
        inputChars
      }
    } catch (cause) {
      signal.throwIfAborted()
      this.fail(cause)
      return { inputIndex: args.inputIndex, round: this.round, kind: 'failed', inputChars }
    } finally {
      this.busy = false
    }
  }

  apply(raw: SynonymApplyArgs, signal: AbortSignal): SynonymApplied {
    const args = synonymApplyArgsSchema.parse(raw)
    this.checkCurrent(args.inputIndex)
    this.check(
      !this.busy && !!this.proposal && args.round === this.round && !this.terminal && !this.failure
    )
    signal.throwIfAborted()
    const proposal = this.proposal!
    const parallel = proposal.message.tool_calls.length > 1
    this.check(args.action === (parallel ? 'reject_parallel' : 'execute'))
    this.proposal = undefined
    try {
      this.checkDeadline()
      const message = proposal.message
      if (parallel) {
        this.check(proposal.canCorrectParallel && !this.corrected)
        this.corrected = true
        this.messages.push({ ...message, role: 'assistant' })
        for (const call of message.tool_calls)
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: 'SINGLE_TOOL_CALL_REQUIRED' })
          })
      } else {
        const call = message.tool_calls[0]
        let data: unknown
        try {
          data = JSON.parse(call.function.arguments)
        } catch (cause) {
          throw new SynonymError('INVALID_ANALYSIS', { cause })
        }
        const outcome = this.executor!.execute(call.function.name, data)
        this.messages.push(
          { ...message, role: 'assistant' },
          { role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.result) }
        )
        this.terminal = outcome.terminal
      }
      return {
        inputIndex: args.inputIndex,
        round: this.round,
        kind: this.terminal ? 'terminal' : 'continue'
      }
    } catch (cause) {
      signal.throwIfAborted()
      this.fail(cause)
      return { inputIndex: args.inputIndex, round: this.round, kind: 'failed' }
    }
  }

  finish(raw: SynonymFinishArgs): SynonymFinished {
    const args = synonymFinishArgsSchema.parse(raw)
    this.checkCurrent(args.inputIndex)
    this.check(!this.busy && !this.proposal && args.round === this.round)
    if (args.reason === 'round_limit') {
      this.check(this.round === 52 && !this.failure && !this.terminal)
      this.fail(new SynonymError('ROUND_LIMIT'))
    } else this.check(args.reason === (this.failure ? 'failed' : this.terminal ? 'terminal' : ''))
    if (!this.failure && this.results[args.inputIndex].status === 'cancelled')
      this.results[args.inputIndex] = { ...this.items[args.inputIndex], status: 'unrecognized' }
    this.completed.add(args.inputIndex)
    const stop = this.failure?.code === 'TOOL_CALL_NOT_SUPPORTED'
    this.position++
    if (stop)
      for (const index of this.pending.slice(this.position)) {
        this.results[index] = {
          ...this.items[index],
          status: 'failed',
          code: 'TOOL_CALL_NOT_SUPPORTED'
        }
        this.completed.add(index)
        this.position++
      }
    this.persist(false)
    this.round = 0
    this.ids.clear()
    this.messages = []
    this.prompt = undefined
    this.executor = undefined
    this.failure = undefined
    this.terminal = false
    this.corrected = false
    return { inputIndex: args.inputIndex, stop }
  }

  verifyCompletion(result: SynonymCompletion): void {
    this.check(
      !this.verified &&
        this.prepared &&
        !this.busy &&
        !this.proposal &&
        this.position === this.pending.length &&
        result.completedIndices.length === this.pending.length &&
        new Set(result.completedIndices).size === this.pending.length &&
        this.pending.every((i) => this.completed.has(i) && result.completedIndices.includes(i))
    )
    this.verified = true
  }

  report(finalized: boolean, results = this.results): SynonymBatch {
    return synonymBatchSchema.parse({
      requestId: this.input.requestId,
      finalized,
      explanationLanguage: this.input.explanationLanguage,
      items: structuredClone(results),
      outcome: synonymOutcome(results)
    })
  }
  persist(finalized: boolean): SynonymBatch {
    const report = this.report(finalized)
    this.repository.saveReport(this.input.executionId, report)
    return report
  }
  close(): void {
    this.closed = true
  }
  private check(valid: boolean): void {
    if (this.closed || !valid) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
  }
  private checkCurrent(index: number): void {
    this.check(!this.verified && this.prepared && this.pending[this.position] === index)
  }
  private checkDeadline(): void {
    if (performance.now() >= this.deadline) throw new SynonymError('TIMEOUT')
  }
  private fail(cause: unknown): void {
    if (cause instanceof AgentRuntimeError) throw cause
    const failure =
      cause instanceof SynonymError ? cause : new SynonymError('MODEL_ERROR', { cause })
    this.failure = failure
    const index = this.pending[this.position]
    if (!['saved', 'existing'].includes(this.results[index].status))
      this.results[index] =
        failure.code === 'CANCELLED'
          ? { ...this.items[index], status: 'cancelled' }
          : { ...this.items[index], status: 'failed', code: failure.code }
    if (failure.code !== 'CANCELLED')
      this.diagnostics.report({
        module: 'synonym',
        operation: 'word',
        code: failure.code,
        message: 'synonym word analysis failed',
        context: { chain: summarizeSynonymFailure(failure) }
      })
  }
}
