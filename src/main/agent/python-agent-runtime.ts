import { randomUUID } from 'node:crypto'
import type { LanguageModel, ModelStreamEvent } from '../../core/llm/language-model'
import { AgentHost, type AgentTestOperations } from '../../core/agent/agent-host'
import {
  AgentRuntimeError,
  createAgentSnapshot,
  type AgentRunInput,
  type AgentRuntime
} from '../../core/agent/agent-runtime'
import type { AgentFrame } from '../../core/agent/agent-protocol'
import { PythonAgentProcess } from './python-agent-process'

interface Run {
  controller: AbortController
  host: AgentHost
  queue: ModelStreamEvent[]
  wake: () => void
  done: boolean
  sent: boolean
  cancelSent: boolean
  openCall: boolean
  pythonDone: boolean
  error?: unknown
  seq: number
  text: string
  chars: number
  maxChars: number
  hostFailure?: unknown
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
    private readonly testOperations?: AgentTestOperations
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
    input.signal.throwIfAborted()
    if (this.closed || this.runs.size >= 8) throw new AgentRuntimeError('AGENT_UNAVAILABLE')
    const { signal } = input
    const task = {
      task: input.task,
      messages: input.messages,
      outputLanguage: input.outputLanguage,
      targetLanguage: input.targetLanguage
    }
    const snapshot = createAgentSnapshot(task)
    const controller = new AbortController()
    const runId = randomUUID()
    const run: Run = {
      controller,
      host: new AgentHost(snapshot, this.resolveModel, this.testOperations),
      queue: [],
      wake: () => {},
      done: false,
      sent: false,
      cancelSent: false,
      openCall: false,
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
    if (frame.type === 'result' || frame.type === 'error' || frame.type === 'cancelled') {
      clearTimeout(this.cancellations.get(frame.runId))
      this.cancellations.delete(frame.runId)
      if (run) run.pythonDone = true
    }
    if (!run) {
      if (!this.retired.has(frame.runId)) this.process.invalidate()
      return
    }
    if (run.done) return
    switch (frame.type) {
      case 'host_call': {
        if (
          run.openCall ||
          !frame.callId.startsWith(`${frame.runId}:`) ||
          run.calls.has(frame.callId)
        ) {
          this.finish(frame.runId, run, new AgentRuntimeError('AGENT_PROTOCOL_ERROR'))
          return
        }
        run.calls.add(frame.callId)
        run.openCall = true
        void this.hostCall(frame, run)
        return
      }
      case 'event':
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
      case 'result':
        this.finish(
          frame.runId,
          run,
          frame.text === run.text ? undefined : new AgentRuntimeError('AGENT_PROTOCOL_ERROR')
        )
        return
      case 'error':
        this.finish(frame.runId, run, run.hostFailure ?? new AgentRuntimeError(frame.code))
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
      run.hostFailure = error
      try {
        await this.process.send({
          type: 'host_error',
          runId: frame.runId,
          callId: frame.callId,
          code: error instanceof AgentRuntimeError ? error.code : 'AGENT_HOST_ERROR'
        })
      } catch (cause) {
        this.finish(frame.runId, run, cause)
      }
    } finally {
      run.openCall = false
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
