import {
  createAgentTaskBinding,
  type AgentTaskBindingInput,
  type BatchTaskBindingInput
} from '../../core/agent/agent-task-binding'
import type { AgentTaskBinding } from '../../core/agent/agent-task'
import { describeConversationRoute } from '../../core/agent/tasks/conversation-route-task'
import { getAgentTaskPolicy, isAgentSuccessFrame } from '../../core/agent/agent-task-policy'
import { randomUUID } from 'node:crypto'
import type { LanguageModel, ModelStreamEvent } from '../../core/llm/language-model'
import { AgentHost, type AgentTestOperations } from '../../core/agent/agent-host'
import {
  type SentenceHostOperations,
  type TtsHostOperations,
  type TtsAgentRunInput,
  type VocabularyPracticeHostOperations,
  type VocabularyPracticeAgentRuntime,
  type SentencePracticeAgentRuntime,
  type SentencePracticeHostOperations,
  AgentRuntimeError,
  createAgentSnapshot,
  type ExploreVocabularyAgentRunInput,
  type ExploreVocabularyHostOperations,
  type ExplorePhraseAgentRunInput,
  type ExplorePhraseHostOperations,
  type AgentRunInput,
  type ConversationRouteRunInput,
  type AgentRuntime,
  type VocabularyHostOperations,
  type PhraseAgentRunInput,
  type PhraseHostOperations,
  type SynonymHostOperations,
  type SynonymAgentRunInput,
  type VocabularyAgentRunInput
} from '../../core/agent/agent-runtime'
import {
  agentSnapshotSchema,
  type AgentFrame,
  type AgentSnapshot,
  type ConversationRouteResult
} from '../../core/agent/agent-protocol'
import { PythonAgentProcess } from './python-agent-process'

type BatchTask = BatchTaskBindingInput['task']

// Batch snapshots still require one message; the batch graphs never read it.
const BATCH_MESSAGE: Record<BatchTask, string> = {
  sentence: 'Bound sentence translation',
  tts: 'Bound speech synthesis',
  'vocabulary-practice-review': 'Bound vocabulary practice',
  'sentence-practice-hints': 'Bound sentence practice',
  'sentence-practice-review': 'Bound sentence practice',
  vocabulary: 'Vocabulary batch',
  phrase: 'Phrase batch',
  synonym: 'Synonym batch',
  'explore-phrase': 'Exploration batch',
  'explore-vocabulary': 'Vocabulary exploration batch'
}

interface Run {
  controller: AbortController
  host: AgentHost
  queue: ModelStreamEvent[]
  wake: () => void
  done: boolean
  sent: boolean
  cancelSent: boolean
  openCalls: Map<string, string>
  binding: AgentTaskBinding
  pythonDone: boolean
  error?: unknown
  seq: number
  text: string
  chars: number
  maxChars: number
  calls: Set<string>
}

export class PythonAgentRuntime implements AgentRuntime {
  private readonly runs = new Map<string, Run>()
  private readonly retired = new Set<string>()
  private readonly unsubscribe: () => void
  private closed = false
  private readonly cancellations = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(
    private readonly process: PythonAgentProcess,
    private readonly resolveModel: () => LanguageModel,
    private readonly testOperations?: AgentTestOperations,
    private readonly onRouteMeasured?: (metrics: { durationMs: number; modelCalls: number }) => void
  ) {
    this.unsubscribe = process.subscribe(
      (frame) => this.receive(frame),
      (error) => {
        this.clearCancellations()
        for (const [runId, run] of this.runs) this.finish(runId, run, error)
      }
    )
  }

  async *stream(input: AgentRunInput): AsyncIterable<ModelStreamEvent> {
    switch (input.task) {
      case 'conversation':
      case 'concept':
      case 'conversation-title':
        yield* this.run(createAgentSnapshot(input), input.signal, {
          task: input.task,
          resolveModel: this.resolveModel
        })
        return
      case 'tool-loop':
        if (!this.testOperations) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        yield* this.run(createAgentSnapshot(input), input.signal, {
          task: input.task,
          operations: this.testOperations
        })
        return
      default:
        throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
    }
  }

  async routeConversation(input: ConversationRouteRunInput): Promise<ConversationRouteResult> {
    const started = performance.now()
    let modelCalls = 0
    let result: ConversationRouteResult | undefined
    const task = 'conversation-route'
    const policy = getAgentTaskPolicy(task)
    const snapshot = agentSnapshotSchema.parse({
      task,
      messages: [],
      route: describeConversationRoute(input.mode, input.text),
      inputChars: input.text.length,
      outputLanguage: input.outputLanguage,
      targetLanguage: input.targetLanguage,
      budget: policy.budget,
      allowedOperations: policy.allowedOperations
    })
    try {
      for await (const event of this.run(snapshot, input.signal, {
        task,
        text: input.text,
        resolveModel: this.resolveModel,
        complete: (selected) => {
          result = selected
        },
        modelStarted: () => {
          modelCalls++
        }
      }))
        void event
      if (!result) throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
      return result
    } finally {
      this.onRouteMeasured?.({ durationMs: Math.round(performance.now() - started), modelCalls })
    }
  }

  async runVocabularyPractice(
    input: Parameters<VocabularyPracticeAgentRuntime['runVocabularyPractice']>[0],
    host: VocabularyPracticeHostOperations
  ): Promise<void> {
    await this.runBatch(input, { task: 'vocabulary-practice-review', host })
  }

  async runSentencePractice(
    input: Parameters<SentencePracticeAgentRuntime['runSentencePractice']>[0],
    host: SentencePracticeHostOperations
  ): Promise<void> {
    await this.runBatch(input, { task: input.task, host })
  }

  async runVocabulary(
    input: VocabularyAgentRunInput,
    host: VocabularyHostOperations
  ): Promise<void> {
    await this.runBatch(input, { task: 'vocabulary', host })
  }

  async runPhrase(input: PhraseAgentRunInput, host: PhraseHostOperations): Promise<void> {
    await this.runBatch(input, { task: 'phrase', host })
  }

  async runSynonym(input: SynonymAgentRunInput, host: SynonymHostOperations): Promise<void> {
    await this.runBatch(input, { task: 'synonym', host })
  }

  async runExplorePhrase(
    input: ExplorePhraseAgentRunInput,
    host: ExplorePhraseHostOperations
  ): Promise<void> {
    await this.runBatch(input, { task: 'explore-phrase', host })
  }

  async runExploreVocabulary(
    input: ExploreVocabularyAgentRunInput,
    host: ExploreVocabularyHostOperations
  ): Promise<void> {
    await this.runBatch(input, { task: 'explore-vocabulary', host })
  }

  private async runBatch(
    input:
      | Parameters<SentencePracticeAgentRuntime['runSentencePractice']>[0]
      | VocabularyAgentRunInput
      | PhraseAgentRunInput
      | SynonymAgentRunInput
      | ExplorePhraseAgentRunInput
      | ExploreVocabularyAgentRunInput,
    bindingInput: BatchTaskBindingInput
  ): Promise<void> {
    const task = bindingInput.task
    for await (const event of this.run(
      createAgentSnapshot({
        ...input,
        task,
        messages: [{ role: 'user', content: BATCH_MESSAGE[task] }]
      }),
      input.signal,
      bindingInput
    ))
      void event
  }

  runSentence(input: VocabularyAgentRunInput, host: SentenceHostOperations): Promise<void> {
    return this.runBatch(input, { task: 'sentence', host })
  }

  runTts(input: TtsAgentRunInput, host: TtsHostOperations): Promise<void> {
    return this.runBatch(input, { task: 'tts', host })
  }

  private async *run(
    snapshot: AgentSnapshot,
    signal: AbortSignal,
    bindingInput: AgentTaskBindingInput
  ): AsyncIterable<ModelStreamEvent> {
    signal.throwIfAborted()
    if (this.closed || this.runs.size >= 8) throw new AgentRuntimeError('AGENT_UNAVAILABLE')
    const binding = createAgentTaskBinding(snapshot, bindingInput)
    const controller = new AbortController()
    const runId = randomUUID()
    const run: Run = {
      controller,
      host: new AgentHost(snapshot, binding),
      queue: [],
      wake: () => {},
      done: false,
      sent: false,
      cancelSent: false,
      openCalls: new Map(),
      binding,
      pythonDone: false,
      seq: 0,
      text: '',
      chars: 0,
      maxChars: snapshot.budget.maxOutputChars,
      calls: new Set()
    }
    this.runs.set(runId, run)
    const cancel = (error: unknown): void => this.finish(runId, run, error)
    const onAbort = (): void => cancel(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(
      () => cancel(new AgentRuntimeError('AGENT_LIMIT')),
      snapshot.budget.timeoutMs
    )
    const interrupted = new Promise<void>((_, reject) => {
      const abort = (): void => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abort, { once: true })
      if (controller.signal.aborted) abort()
    })
    try {
      // A queued run must reach Python before its cancel. The caller can still
      // leave immediately while the bounded transport drains that frame.
      await Promise.race([this.process.start(), interrupted])
      if (run.done) throw run.error
      const sending = this.process.send({ type: 'run', runId, snapshot }).then(() => {
        run.sent = true
        if (run.done) this.cancelPython(runId, run)
      })
      await Promise.race([sending, interrupted])
      while (!run.done || run.queue.length) {
        if (run.queue.length) {
          yield run.queue.shift()!
          continue
        }
        await new Promise<void>((resolve) => {
          run.wake = resolve
        })
      }
      if (run.error) throw run.error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (!run.done) cancel(new DOMException('Consumer closed', 'AbortError'))
      controller.abort()
      this.runs.delete(runId)
    }
  }

  private receive(frame: AgentFrame): void {
    if (frame.type === 'shutdown_ack') return
    if (!('runId' in frame)) {
      this.process.invalidate()
      return
    }
    const run = this.runs.get(frame.runId)
    if (isAgentSuccessFrame(frame) || frame.type === 'error' || frame.type === 'cancelled') {
      clearTimeout(this.cancellations.get(frame.runId))
      this.cancellations.delete(frame.runId)
      if (run) run.pythonDone = true
    }
    if (!run) {
      if (!this.retired.has(frame.runId)) this.process.invalidate()
      return
    }
    if (run.done) return
    if (isAgentSuccessFrame(frame)) {
      try {
        if (frame.type !== run.binding.policy.successFrame || run.openCalls.size)
          throw new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        run.binding.adapter.verifyCompletion(frame, run.text)
        this.finish(frame.runId, run)
      } catch (error) {
        this.finish(frame.runId, run, error)
      }
      return
    }
    switch (frame.type) {
      case 'host_call': {
        if (
          (run.openCalls.size > 0 &&
            (!run.binding.policy.concurrency.operation ||
              frame.operation !== run.binding.policy.concurrency.operation ||
              [...run.openCalls.values()].some(
                (operation) => operation !== run.binding.policy.concurrency.operation
              ))) ||
          run.openCalls.size >= run.binding.policy.concurrency.max ||
          !frame.callId.startsWith(`${frame.runId}:`) ||
          run.calls.has(frame.callId)
        ) {
          this.finish(frame.runId, run, new AgentRuntimeError('AGENT_PROTOCOL_ERROR'))
          return
        }
        run.calls.add(frame.callId)
        run.openCalls.set(frame.callId, frame.operation)
        void this.hostCall(frame, run)
        return
      }
      case 'event':
        if (run.binding.policy.events !== 'stream') {
          this.finish(frame.runId, run, new AgentRuntimeError('AGENT_PROTOCOL_ERROR'))
          return
        }
        if (frame.seq !== run.seq + 1 || run.queue.length >= 1024) {
          this.finish(frame.runId, run, new AgentRuntimeError('AGENT_PROTOCOL_ERROR'))
          return
        }
        run.seq = frame.seq
        run.chars += frame.event.delta.length
        if (run.chars > run.maxChars) {
          this.finish(frame.runId, run, new AgentRuntimeError('AGENT_LIMIT'))
          return
        }
        if (frame.event.type === 'text') run.text += frame.event.delta
        run.queue.push(frame.event)
        run.wake()
        return
      case 'error':
        this.finish(frame.runId, run, new AgentRuntimeError(frame.code))
        return
      case 'cancelled':
        this.finish(frame.runId, run, new DOMException('Aborted', 'AbortError'))
        return
      default:
        this.finish(frame.runId, run, new AgentRuntimeError('AGENT_PROTOCOL_ERROR'))
    }
  }
  private async hostCall(
    frame: Extract<AgentFrame, { type: 'host_call' }>,
    run: Run
  ): Promise<void> {
    let seq = 0
    try {
      const result = await run.host.call(
        frame.callId,
        frame.operation,
        frame.args,
        async (event) => {
          if (!run.done)
            await this.process.send({
              type: 'host_chunk',
              runId: frame.runId,
              callId: frame.callId,
              seq: ++seq,
              event
            })
        },
        run.controller.signal
      )
      if (!run.done)
        await this.process.send({
          type: 'host_result',
          runId: frame.runId,
          callId: frame.callId,
          result
        })
    } catch (error) {
      if (run.done) return
      this.finish(frame.runId, run, error)
    } finally {
      run.openCalls.delete(frame.callId)
    }
  }
  private cancelPython(runId: string, run: Run): void {
    if (
      !run.sent ||
      run.cancelSent ||
      run.pythonDone ||
      this.closed ||
      this.process.status !== 'ready'
    )
      return
    run.cancelSent = true
    const instanceId = this.process.instanceId
    this.cancellations.set(
      runId,
      setTimeout(() => {
        this.cancellations.delete(runId)
        if (this.process.instanceId === instanceId) this.process.invalidate('AGENT_UNAVAILABLE')
      }, 1000)
    )
    void this.process.send({ type: 'cancel', runId }, true).catch(() => this.process.invalidate())
  }
  private finish(runId: string, run: Run, error?: unknown): void {
    if (run.done) return
    run.done = true
    run.error = error
    if (error) {
      run.queue.length = 0
      this.cancelPython(runId, run)
    }
    run.controller.abort(error)
    this.retired.add(runId)
    if (this.retired.size > 128) this.retired.delete(this.retired.values().next().value!)
    run.wake()
  }
  private clearCancellations(): void {
    for (const timer of this.cancellations.values()) clearTimeout(timer)
    this.cancellations.clear()
  }
  async dispose(): Promise<void> {
    this.closed = true
    this.clearCancellations()
    for (const [id, run] of this.runs)
      this.finish(id, run, new AgentRuntimeError('AGENT_UNAVAILABLE'))
    await this.process.shutdown()
    this.unsubscribe()
  }
}
